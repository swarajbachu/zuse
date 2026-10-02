import {
	ChatId,
	FolderId,
	RpcAccessDeniedError,
	RpcAuthorization,
	SessionId,
	TeamId,
	type TeamMemberId,
	WORKSPACE_SCOPE_HEADER,
	WorkspaceScopeHeader,
	WorktreeId,
} from "@zuse/contracts";
import {
	Effect,
	Layer,
	Option,
	PubSub,
	Queue,
	Schema,
	Stream,
	SubscriptionRef,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AuthService } from "../../auth/services/auth-service.ts";
import {
	CatalogVisibility,
	CatalogVisibilityChanges,
} from "../../collaboration/services/catalog-visibility.ts";
import { CollaborationService } from "../../collaboration/services/collaboration-service.ts";
import { WorkspaceFileAccess } from "../../collaboration/services/workspace-file-access.ts";
import { RequestWorkspace } from "../../machine/request-workspace.ts";
import { ConnectionIdentity } from "../services/connection-identity.ts";
import { authorizeWorkspaceRpc } from "./workspace-rpc-authorization.ts";

export const RpcAuthorizationLive = Layer.effect(
	RpcAuthorization,
	Effect.gen(function* () {
		const auth = yield* AuthService;
		const sql = yield* SqlClient.SqlClient;
		const collaboration = yield* CollaborationService;
		return RpcAuthorization.of((effect, { rpc, payload, headers }) =>
			Effect.gen(function* () {
				const scope = yield* Schema.decodeUnknownEffect(WorkspaceScopeHeader)(
					headers[WORKSPACE_SCOPE_HEADER] ?? "personal",
				).pipe(
					Effect.mapError(
						() => new RpcAccessDeniedError({ code: "access-denied" }),
					),
				);
				const scopedRequest = Effect.provideService(
					effect,
					RequestWorkspace,
					scope,
				);
				if (
					scope !== "personal" &&
					!rpc._tag.startsWith("cloud.") &&
					rpc._tag !== "machines.checkout" &&
					rpc._tag !== "machines.billingPortal" &&
					rpc._tag !== "machines.entitlements"
				)
					return yield* new RpcAccessDeniedError({ code: "access-denied" });
				const identity = yield* Effect.serviceOption(ConnectionIdentity);
				if (Option.isSome(identity) && identity.value.kind === "workspace")
					return yield* authorizeWorkspaceRpc(
						scopedRequest,
						identity.value,
						rpc._tag,
						payload,
					).pipe(Effect.provideService(SqlClient.SqlClient, sql));
				// Native IPC and explicitly paired devices retain their existing host
				// authority. Account connections never inherit it from the transport.
				if (Option.isNone(identity) || identity.value.kind !== "account")
					return yield* scopedRequest;
				const account = identity.value;
				const revocations = yield* collaboration.subscribeAccessRevocations;
				const isCatalogStream =
					rpc._tag === "workspace.streamChanges" ||
					rpc._tag === "chat.streamChanges" ||
					rpc._tag === "session.streamChanges" ||
					rpc._tag === "chat.creation.stream";
				const catalogChanges = isCatalogStream
					? yield* collaboration.subscribeCatalogChanges
					: null;
				let catalogRevision = 0;
				let authorityClass: "host" | "guest" | null = null;
				let catalogScope: CatalogVisibility["Service"] | null = null;
				let fileScope: WorkspaceFileAccess["Service"] | null = null;
				let guestScope: {
					chatId: ChatId;
					memberId: TeamMemberId;
					owner: boolean;
				} | null = null;
				const authorize = Effect.gen(function* () {
					if (account.expiresAt <= Date.now())
						return yield* new RpcAccessDeniedError({
							code: "credential-expired",
						});
					const session = yield* auth.getSession();
					if (session._tag !== "SignedIn")
						return yield* new RpcAccessDeniedError({ code: "access-denied" });
					const currentAuthority =
						session.session.user.id === account.subject ? "host" : "guest";
					// A running unfiltered host feed cannot turn into a guest feed
					// after an account switch. Reconnect with a fresh request scope.
					if (authorityClass !== null && authorityClass !== currentAuthority)
						return yield* new RpcAccessDeniedError({ code: "access-denied" });
					authorityClass = currentAuthority;
					if (currentAuthority === "host") {
						guestScope = null;
						catalogScope = null;
						return;
					}
					if (rpc._tag === "connect.handshake" || rpc._tag === "ping.ping") {
						const visible = yield* collaboration.visibleWorkspaces(
							account.subject,
						);
						if (visible.length === 0)
							return yield* new RpcAccessDeniedError({ code: "access-denied" });
						return;
					}
					if (
						rpc._tag === "workspace.list" ||
						isCatalogStream ||
						rpc._tag === "chat.creation.list" ||
						rpc._tag === "chat.list" ||
						rpc._tag === "session.list"
					) {
						const revision = catalogRevision;
						const visible = yield* collaboration.visibleWorkspaces(
							account.subject,
						);
						if (revision !== catalogRevision) return;
						catalogScope = {
							chats: new Set(visible.map((item) => item.chatId)),
							projects: new Set(visible.map((item) => item.projectId)),
						};
						return;
					}
					let chatId: ChatId;
					if (
						rpc._tag === "fs.readFile" ||
						rpc._tag === "fs.tree" ||
						rpc._tag === "fs.listPaths" ||
						rpc._tag === "fs.watchTree"
					) {
						const { folderId, worktreeId } = yield* Schema.decodeUnknownEffect(
							Schema.Struct({
								folderId: FolderId,
								worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
							}),
						)(payload);
						const visible = yield* collaboration.visibleWorkspaces(
							account.subject,
						);
						const allowed = new Set(visible.map((item) => item.chatId));
						// Project visibility alone does not grant access to its main
						// checkout or another session's isolated worktree.
						const candidates = yield* sql<{ readonly id: string }>`
							SELECT id FROM chats WHERE project_id = ${folderId}
							AND worktree_id IS ${worktreeId ?? null} ORDER BY id`;
						const selected = candidates.find((row) =>
							allowed.has(ChatId.make(row.id)),
						);
						if (selected === undefined)
							return yield* new RpcAccessDeniedError({ code: "access-denied" });
						chatId = ChatId.make(selected.id);
						fileScope = { folderId, worktreeId: worktreeId ?? null };
					} else if (rpc._tag === "chat.get") {
						chatId = (yield* Schema.decodeUnknownEffect(
							Schema.Struct({ chatId: ChatId }),
						)(payload)).chatId;
					} else {
						switch (rpc._tag) {
							case "session.get":
							case "attachments.read":
							case "messages.list":
							case "session.events":
							case "session.events.head":
							case "session.messages.page":
								break;
							default:
								return yield* new RpcAccessDeniedError({
									code: "access-denied",
								});
						}
						const { sessionId } = yield* Schema.decodeUnknownEffect(
							Schema.Struct({ sessionId: SessionId }),
						)(payload);
						const rows = yield* sql<{
							readonly chat_id: string;
						}>`SELECT chat_id FROM sessions WHERE id = ${sessionId}`;
						if (rows[0] === undefined)
							return yield* new RpcAccessDeniedError({ code: "access-denied" });
						chatId = ChatId.make(rows[0].chat_id);
					}
					const workspaces = yield* sql<{
						readonly team_id: string;
					}>`SELECT team_id FROM collaboration_workspaces WHERE chat_id = ${chatId}`;
					if (workspaces[0] === undefined)
						return yield* new RpcAccessDeniedError({ code: "access-denied" });
					const actor = yield* collaboration.resolveActor(
						TeamId.make(workspaces[0].team_id),
						account.subject,
					);
					const grant = yield* collaboration.requireWorkspaceRole(
						actor,
						chatId,
						"viewer",
					);
					guestScope = {
						chatId,
						memberId: actor.memberId,
						owner: grant === null,
					};
					if (rpc._tag === "chat.get")
						catalogScope = { chats: new Set([chatId]), projects: new Set() };
				}).pipe(
					Effect.andThen(
						Effect.suspend(() =>
							account.expiresAt <= Date.now()
								? Effect.fail(
										new RpcAccessDeniedError({ code: "credential-expired" }),
									)
								: Effect.void,
						),
					),
					Effect.mapError((error) =>
						error._tag === "RpcAccessDeniedError"
							? error
							: new RpcAccessDeniedError({ code: "access-denied" }),
					),
				);
				yield* authorize;
				if (catalogChanges !== null && catalogScope !== null) {
					const refreshRequests = yield* Queue.make<void>({
						capacity: 1,
						strategy: "sliding",
					});
					const updates =
						yield* SubscriptionRef.make<CatalogVisibility["Service"]>(
							catalogScope,
						);
					const changes = SubscriptionRef.changes(updates).pipe(
						Stream.changesWith(
							(left, right) =>
								left.chats.size === right.chats.size &&
								left.projects.size === right.projects.size &&
								[...left.chats].every((id) => right.chats.has(id)) &&
								[...left.projects].every((id) => right.projects.has(id)),
						),
					);
					const revoke = Effect.forever(
						PubSub.take(revocations).pipe(
							Effect.flatMap(() => {
								catalogRevision += 1;
								catalogScope = { chats: new Set(), projects: new Set() };
								return SubscriptionRef.set(updates, catalogScope).pipe(
									Effect.andThen(Queue.offer(refreshRequests, undefined)),
								);
							}),
						),
					);
					const refresh = Effect.forever(
						Effect.raceFirst(
							Queue.take(refreshRequests),
							Effect.sleep(20_000),
						).pipe(
							Effect.andThen(authorize),
							Effect.andThen(
								Effect.suspend(() =>
									catalogScope === null
										? Effect.fail(
												new RpcAccessDeniedError({ code: "access-denied" }),
											)
										: SubscriptionRef.set(updates, catalogScope),
								),
							),
						),
					);
					const expired = Effect.sleep(
						Math.max(0, account.expiresAt - Date.now()),
					).pipe(
						Effect.andThen(
							Effect.fail(
								new RpcAccessDeniedError({ code: "credential-expired" }),
							),
						),
					);
					return yield* Effect.raceFirst(
						Effect.provideService(
							scopedRequest,
							CatalogVisibilityChanges,
							changes,
						),
						Effect.raceFirst(
							expired,
							Effect.raceFirst(
								Effect.forever(
									PubSub.take(catalogChanges).pipe(
										Effect.andThen(Queue.offer(refreshRequests, undefined)),
									),
								),
								Effect.raceFirst(revoke, refresh),
							),
						),
					);
				}
				const watchRevocations = Effect.forever(
					PubSub.take(revocations).pipe(
						Effect.flatMap((event) => {
							if (catalogScope !== null)
								return Effect.fail(
									new RpcAccessDeniedError({ code: "access-denied" }),
								);
							if (guestScope === null) return Effect.void;
							const affected =
								event.kind === "workspace"
									? event.chatId === guestScope.chatId
									: event.kind === "member"
										? event.memberId === guestScope.memberId
										: !guestScope.owner &&
											event.chatId === guestScope.chatId &&
											event.memberId === guestScope.memberId;
							return affected
								? Effect.fail(
										new RpcAccessDeniedError({ code: "access-denied" }),
									)
								: Effect.void;
						}),
					),
				);
				// Long-lived subscriptions must not retain authority after logout or
				// credential expiry. Cancellation closes the existing RPC stream.
				const scopedEffect =
					fileScope === null
						? scopedRequest
						: Effect.provideService(
								scopedRequest,
								WorkspaceFileAccess,
								fileScope,
							);
				return yield* Effect.raceFirst(
					catalogScope === null
						? scopedEffect
						: Effect.provideService(
								scopedEffect,
								CatalogVisibility,
								catalogScope,
							),
					Effect.raceFirst(
						Effect.raceFirst(
							watchRevocations,
							// Host catalog requests do not need scope refreshes, but their
							// pre-authorization subscription must not accumulate signals.
							catalogChanges === null
								? Effect.never
								: Effect.forever(PubSub.take(catalogChanges)),
						),
						Effect.forever(
							Effect.suspend(() =>
								Effect.sleep(
									Math.max(0, Math.min(20_000, account.expiresAt - Date.now())),
								),
							).pipe(Effect.andThen(authorize)),
						),
					),
				);
			}),
		);
	}),
);
