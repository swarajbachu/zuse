import {
	ChatAlreadyStartedError,
	type ChatArchiveResult,
	ChatArchiveScriptError,
	ChatArchiveWorktreeError,
	ChatId,
	ChatNotFoundError,
	type FolderId,
	SessionId,
	type Worktree,
	WorktreeId,
} from "@zuse/contracts";
import type { ChatCommand } from "@zuse/domain/chat/commands";
import type { SessionCommand } from "@zuse/domain/core/commands";
import type { WorktreeServiceShape } from "@zuse/git/worktree-service";
import { Effect, Ref, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { makeReactorEffectJournal } from "../../provider/reactor-effect-journal.ts";
import type { PtyServiceShape } from "../../pty/services/pty-service.ts";
import type { RepositorySettingsServiceShape } from "../../repository-settings/services/repository-settings-service.ts";
import type { ConversationOperations } from "../services/conversation-services.ts";
import { runArchiveScript } from "./conversation-archive-script.ts";
import type {
	ConversationReactorHandlers,
	ConversationReactorRuntime,
} from "./conversation-reactors.ts";
import {
	type ChatRow,
	parseArchivedWorktreeSnapshot,
	type SessionRow,
	sessionFromRow,
} from "./conversation-records.ts";
import type { ConversationStateApi } from "./conversation-state.ts";

const decodeArchiveCleanupDetail = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Struct({ output: Schema.String })),
);

export interface ArchiveOperationsOptions {
	readonly sql: SqlClient.SqlClient;
	readonly currentTimestamp: Effect.Effect<number>;
	readonly lookupChat: ConversationOperations["getChat"];
	readonly dispatchChatCommand: (
		chatId: ChatId,
		command: ChatCommand,
		commandId?: string,
	) => Effect.Effect<void>;
	readonly dispatchSessionCommand: (
		sessionId: SessionId,
		command: SessionCommand,
	) => Effect.Effect<void>;
	readonly appendSessionCommand: (
		sessionId: SessionId,
		command: SessionCommand,
	) => Effect.Effect<void>;
	readonly closeProvider: (sessionId: SessionId) => Effect.Effect<void>;
	readonly interruptProviderFiber: (
		sessionId: SessionId,
	) => Effect.Effect<void>;
	readonly teardownSubscription: (sessionId: SessionId) => Effect.Effect<void>;
	readonly setStatus: (
		sessionId: SessionId,
		status: "booting" | "idle" | "running" | "closed" | "error",
	) => Effect.Effect<void>;
	readonly repositorySettings: RepositorySettingsServiceShape;
	readonly worktrees: WorktreeServiceShape;
	readonly ptys: PtyServiceShape;
	readonly projectPath: (projectId: FolderId) => Effect.Effect<string | null>;
	readonly reactorEffects: ReturnType<typeof makeReactorEffectJournal>;
	readonly state: ConversationStateApi;
}

export const makeArchiveOperations = Effect.fn("ArchiveOperations.make")(
	function* (options: ArchiveOperationsOptions) {
		const {
			sql,
			currentTimestamp,
			lookupChat,
			dispatchChatCommand,
			dispatchSessionCommand,
			appendSessionCommand,
			closeProvider,
			interruptProviderFiber,
			teardownSubscription,
			setStatus,
			repositorySettings,
			worktrees,
			ptys,
			projectPath,
			reactorEffects,
			state,
		} = options;
		const setChatWorktree: ConversationOperations["setChatWorktree"] = (
			chatId,
			worktreeId,
		) =>
			Effect.gen(function* () {
				yield* lookupChat(chatId);
				const existing = yield* sql<{ readonly id: string }>`
          SELECT m.id FROM messages m
          INNER JOIN sessions s ON s.id = m.session_id
          WHERE s.chat_id = ${chatId} AND m.role = 'user'
          LIMIT 1
        `.pipe(Effect.orDie);
				if (existing.length > 0) {
					return yield* Effect.fail(new ChatAlreadyStartedError({ chatId }));
				}
				const updatedAt = yield* currentTimestamp;
				yield* dispatchChatCommand(chatId, {
					_tag: "SetChatWorktree",
					worktreeId,
					updatedAt,
				});
				// Background-booted sessions (chat.create → session.create with
				// background=true) already spawned a provider CLI in the OLD cwd
				// before the user got a chance to pick a worktree. Kill those so
				// the next `sendMessage` lazy-restarts via `restartProviderSession`,
				// which reads the now-updated `session.worktreeId` and resolves
				// `cwdForWorktree` to the new path. Without this teardown the
				// first user message would land in the wrong working tree.
				const memberSessions = yield* sql<{ readonly id: string }>`
          SELECT id FROM sessions
          WHERE chat_id = ${chatId} AND archived_at IS NULL
        `.pipe(Effect.orDie);
				for (const row of memberSessions) {
					const sid = SessionId.make(row.id);
					yield* dispatchSessionCommand(sid, {
						_tag: "SetWorktree",
						worktreeId,
						updatedAt,
					});
					yield* closeProvider(sid);
					yield* interruptProviderFiber(sid);
					yield* setStatus(sid, "idle");
				}
				return yield* lookupChat(chatId);
			});

		const setChatActiveSession: ConversationOperations["setChatActiveSession"] =
			(chatId, sessionId) =>
				Effect.gen(function* () {
					yield* lookupChat(chatId);
					const member = yield* sql<{ readonly id: string }>`
          SELECT id FROM sessions
          WHERE id = ${sessionId} AND chat_id = ${chatId}
          LIMIT 1
        `.pipe(Effect.orDie);
					if (member.length === 0) return;
					yield* dispatchChatCommand(chatId, {
						_tag: "SetActiveSession",
						sessionId,
						updatedAt: yield* currentTimestamp,
					});
				});

		const performChatArchive = (
			chatId: ChatId,
			force: boolean,
			commandId: string,
		) =>
			Effect.gen(function* () {
				const chat = yield* lookupChat(chatId);
				if (chat.archivedAt !== null) {
					return { chat, cleanup: null };
				}

				const settings = yield* repositorySettings.get(chat.projectId);
				const worktree =
					chat.worktreeId === null
						? null
						: yield* worktrees.get(chat.worktreeId);
				const snapshot =
					worktree === null
						? null
						: {
								id: worktree.id,
								projectId: worktree.projectId,
								path: worktree.path,
								name: worktree.name,
								branch: worktree.branch,
								baseBranch: worktree.baseBranch,
								createdAt: worktree.createdAt.toISOString(),
							};
				const snapshotJson =
					snapshot === null ? null : JSON.stringify(snapshot);

				const liveSessions = yield* sql<{ readonly id: string }>`
          SELECT id FROM sessions
          WHERE chat_id = ${chatId} AND archived_at IS NULL
        `.pipe(Effect.orDie);
				for (const row of liveSessions) {
					const sessionId = SessionId.make(row.id);
					yield* closeProvider(sessionId);
					yield* interruptProviderFiber(sessionId);
				}
				if (worktree !== null) {
					yield* ptys
						.closeByCwdPrefix(worktree.path)
						.pipe(Effect.catch(() => Effect.void));
				}

				let cleanup: { readonly ran: boolean; readonly output: string } | null =
					null;
				const script = settings.archiveCleanupScript?.trim() ?? "";
				if (worktree !== null && script.length > 0) {
					const steps = yield* sql<{
						readonly status: "started" | "completed";
						readonly detail_json: string | null;
					}>`
            SELECT status, detail_json FROM reactor_effect_steps
            WHERE effect_id = ${commandId} AND step = 'cleanup-script'
            LIMIT 1
          `.pipe(Effect.orDie);
					const step = steps[0];
					if (step?.status === "completed") {
						const detail =
							step.detail_json === null
								? { output: "" }
								: yield* decodeArchiveCleanupDetail(step.detail_json).pipe(
										Effect.mapError(
											(cause) =>
												new ChatArchiveScriptError({
													chatId,
													exitCode: null,
													signal: null,
													output: `Stored cleanup result is invalid: ${String(cause)}`,
												}),
										),
									);
						cleanup = {
							ran: true,
							output: detail.output,
						};
					} else if (step?.status === "started") {
						// The process died after claiming this non-idempotent step. We
						// cannot know whether the script ran, so preserve `started` as an
						// auditable indeterminate state and never fabricate completion or
						// run the user's script twice.
						cleanup = null;
					} else {
						yield* sql`
              INSERT INTO reactor_effect_steps
                (effect_id, step, status, detail_json, updated_at)
              VALUES
                (${commandId}, 'cleanup-script', 'started', NULL,
                 ${new Date().toISOString()})
            `.pipe(Effect.orDie);
						const rootPath = yield* projectPath(chat.projectId);
						const result = yield* runArchiveScript({
							chatId,
							script: settings.archiveCleanupScript ?? "",
							cwd: worktree.path,
							env: {
								ZUSE_ROOT_PATH: rootPath ?? "",
								ZUSE_WORKSPACE_PATH: worktree.path,
								ZUSE_CHAT_ID: chatId,
								ZUSE_WORKTREE_ID: worktree.id,
							},
						});
						cleanup = { ran: true, output: result.output };
						yield* sql`
              UPDATE reactor_effect_steps
              SET status = 'completed',
                  detail_json = ${JSON.stringify({ output: result.output })},
                  updated_at = ${new Date().toISOString()}
              WHERE effect_id = ${commandId} AND step = 'cleanup-script'
            `.pipe(Effect.orDie);
					}
				} else if (worktree !== null) {
					cleanup = { ran: false, output: "" };
				}

				if (worktree !== null && settings.archiveRemoveWorktree) {
					yield* worktrees.remove(worktree.id, force).pipe(
						Effect.mapError(
							(err) =>
								new ChatArchiveWorktreeError({
									chatId,
									reason:
										"reason" in err && typeof err.reason === "string"
											? err.reason
											: err._tag,
								}),
						),
					);
				}

				const archivedAt = yield* currentTimestamp;
				yield* Effect.forEach(
					liveSessions,
					({ id }) =>
						appendSessionCommand(SessionId.make(id), {
							_tag: "ArchiveSession",
							archivedAt,
						}),
					{ discard: true },
				);
				yield* dispatchChatCommand(
					chatId,
					{
						_tag: "ArchiveChat",
						archivedAt,
						archivedWorktreeJson: snapshotJson,
					},
					`${commandId}:archive`,
				);
				const result = { chat: yield* lookupChat(chatId), cleanup };
				yield* reactorEffects.complete(commandId);
				return result;
			});

		const chatArchiveResults = yield* Ref.make<
			ReadonlyMap<ChatId, ChatArchiveResult>
		>(new Map());
		const handleChatArchive: ConversationReactorHandlers["chatArchive"] = (
			reactorInput,
		) =>
			Effect.gen(function* () {
				const chatId = ChatId.make(reactorInput.streamId);
				const completed = yield* reactorEffects.isCompleted(
					reactorInput.commandId,
				);
				const result = completed
					? { chat: yield* lookupChat(chatId), cleanup: null }
					: yield* performChatArchive(
							chatId,
							reactorInput.command.force,
							reactorInput.commandId,
						);
				yield* Ref.update(chatArchiveResults, (current) => {
					const next = new Map(current);
					next.set(chatId, result);
					return next;
				});
			});

		const archiveChatWithReactor = (
			chatId: Parameters<ConversationOperations["archiveChat"]>[0],
			force: Parameters<ConversationOperations["archiveChat"]>[1],
			runChatArchive: ConversationReactorRuntime["runChatArchive"],
		) =>
			Effect.gen(function* () {
				const chat = yield* lookupChat(chatId);
				if (chat.archivedAt !== null) return { chat, cleanup: null };
				yield* dispatchChatCommand(chatId, {
					_tag: "RequestArchiveChat",
					force,
					requestedAt: yield* currentTimestamp,
				});
				yield* runChatArchive;
				const results = yield* Ref.get(chatArchiveResults);
				const result = results.get(chatId);
				if (result === undefined) {
					return yield* Effect.die(
						new Error(`chat archive reactor produced no result for ${chatId}`),
					);
				}
				return result;
			});

		const unarchiveChat: ConversationOperations["unarchiveChat"] = (chatId) =>
			Effect.gen(function* () {
				const chatRows = yield* sql<ChatRow>`
          SELECT id, project_id, worktree_id, title, active_session_id, origin_session_id,
                 archived_at, archived_worktree_json, last_message_at, last_read_at, created_at, updated_at
          FROM chats WHERE id = ${chatId} LIMIT 1
        `.pipe(Effect.orDie);
				const chatRow = chatRows[0];
				if (chatRow === undefined) {
					return yield* Effect.fail(new ChatNotFoundError({ chatId }));
				}

				const snapshot = parseArchivedWorktreeSnapshot(
					chatRow.archived_worktree_json,
				);
				let restoredWorktree: Worktree | null = null;
				let restoredWorktreeId: WorktreeId | null =
					chatRow.worktree_id === null
						? null
						: WorktreeId.make(chatRow.worktree_id);
				if (snapshot !== null) {
					const existing = yield* worktrees.get(WorktreeId.make(snapshot.id));
					if (existing !== null) {
						restoredWorktree = existing;
						restoredWorktreeId = existing.id;
					} else if (chatRow.worktree_id === null) {
						restoredWorktree = yield* worktrees
							.restore({
								id: WorktreeId.make(snapshot.id),
								projectId: snapshot.projectId as FolderId,
								path: snapshot.path,
								name: snapshot.name,
								branch: snapshot.branch,
								baseBranch: snapshot.baseBranch,
								createdAt: new Date(snapshot.createdAt),
							})
							.pipe(
								Effect.mapError(
									(err) =>
										new ChatArchiveWorktreeError({
											chatId,
											reason: err.reason,
										}),
								),
							);
						restoredWorktreeId = restoredWorktree.id;
					}
				}

				const unarchivedAt = yield* currentTimestamp;
				yield* dispatchChatCommand(chatId, {
					_tag: "UnarchiveChat",
					unarchivedAt,
					worktreeId: restoredWorktreeId,
				});
				const archivedSessions = yield* sql<{
					readonly id: string;
					readonly worktree_id: string | null;
				}>`
          SELECT id, worktree_id FROM sessions WHERE chat_id = ${chatId}
        `.pipe(Effect.orDie);
				for (const row of archivedSessions) {
					const sessionId = SessionId.make(row.id);
					if (
						restoredWorktreeId !== null &&
						row.worktree_id !== restoredWorktreeId
					) {
						yield* dispatchSessionCommand(sessionId, {
							_tag: "SetWorktree",
							worktreeId: restoredWorktreeId,
							updatedAt: unarchivedAt,
						});
					}
					if (chatRow.archived_at !== null) {
						yield* dispatchSessionCommand(sessionId, {
							_tag: "UnarchiveSession",
							unarchivedAt,
						});
					}
				}
				const sessions = yield* sql<SessionRow>`
          SELECT id, project_id, title, provider_id, model, status,
                 archived_at, cursor, resume_strategy, runtime_mode,
                 agents_json, worktree_id, chat_id, forked_from_session_id,
                 forked_from_message_id, permission_mode, tool_search,
                 created_at, updated_at
          FROM sessions
          WHERE chat_id = ${chatId} AND archived_at IS NULL
          ORDER BY updated_at DESC
        `.pipe(Effect.orDie);
				return {
					chat: yield* lookupChat(chatId),
					sessions: sessions.map(sessionFromRow),
					worktree: restoredWorktree,
				};
			});

		const performChatDelete = (chatId: ChatId, commandId: string) =>
			Effect.gen(function* () {
				yield* lookupChat(chatId);
				// Tear down each child session's provider state before the SQL
				// CASCADE wipes the rows so we don't leak an in-memory pubsub /
				// fiber after the data is gone.
				const childIds = yield* sql<{ readonly id: string }>`
          SELECT id FROM sessions WHERE chat_id = ${chatId}
        `.pipe(Effect.orDie);
				for (const { id } of childIds) {
					const sessionId = SessionId.make(id);
					yield* closeProvider(sessionId);
					yield* teardownSubscription(sessionId);
					yield* appendSessionCommand(sessionId, {
						_tag: "DeleteSession",
						deletedAt: yield* currentTimestamp,
					});
					yield* Effect.sync(() => state.clearSession(sessionId));
				}
				yield* dispatchChatCommand(
					chatId,
					{
						_tag: "DeleteChat",
						deletedAt: yield* currentTimestamp,
					},
					`${commandId}:delete`,
				);
				// ON DELETE CASCADE handles sessions + messages.
			});

		const handleChatDelete: ConversationReactorHandlers["chatDelete"] = (
			reactorInput,
		) =>
			Effect.gen(function* () {
				const deleteCommandId = `${reactorInput.commandId}:delete`;
				const completed = yield* sql<{ readonly command_id: string }>`
            SELECT command_id FROM command_receipts
            WHERE command_id = ${deleteCommandId}
            LIMIT 1
          `.pipe(Effect.orDie);
				if (completed.length > 0) return;
				yield* performChatDelete(
					ChatId.make(reactorInput.streamId),
					reactorInput.commandId,
				);
			});

		return {
			setChatWorktree,
			setChatActiveSession,
			archiveChatWithReactor,
			unarchiveChat,
			deleteChatWithReactor: (
				chatId: ChatId,
				runChatDelete: ConversationReactorRuntime["runChatDelete"],
			) =>
				Effect.gen(function* () {
					yield* lookupChat(chatId);
					yield* dispatchChatCommand(chatId, {
						_tag: "RequestDeleteChat",
						requestedAt: yield* currentTimestamp,
					});
					yield* runChatDelete;
				}),
			handleChatArchive,
			handleChatDelete,
		};
	},
);
