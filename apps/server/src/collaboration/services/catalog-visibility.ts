import {
	Chat,
	type ChatId,
	type ChatSummaryChange,
	type FolderId,
	type PermissionRequestChange,
	type SessionId,
	type SessionSummaryChange,
} from "@zuse/contracts";
import { Context, Effect, Result, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Filter the existing live callback feed, including removal IDs, at the server. */
export const filterPermissionCatalog = <E, R>(
	stream: Stream.Stream<PermissionRequestChange, E, R>,
) =>
	Stream.unwrap(
		Effect.gen(function* () {
			const scope = yield* Effect.serviceOption(CatalogVisibility);
			if (scope._tag === "None") return stream;
			const sql = yield* SqlClient.SqlClient;
			const known = new Set<string>();
			return stream.pipe(
				Stream.mapEffect((change) =>
					Effect.gen(function* () {
						if (change._tag === "remove")
							return known.delete(change.requestId) ? [change] : [];
						const sessions = yield* sql<{
							id: string;
						}>`SELECT id FROM sessions WHERE ${sql.in("chat_id", [...scope.value.chats])}`.pipe(
							Effect.orDie,
						);
						const visible = new Set(sessions.map((s) => s.id));
						if (change._tag === "snapshot") {
							known.clear();
							const requests = change.requests.filter((r) =>
								visible.has(r.sessionId),
							);
							for (const r of requests) known.add(r.id);
							return [{ ...change, requests }];
						}
						if (!visible.has(change.request.sessionId)) return [];
						known.add(change.request.id);
						return [change];
					}),
				),
				Stream.flatMap((changes: ReadonlyArray<PermissionRequestChange>) =>
					Stream.fromIterable(changes),
				),
			);
		}),
	);

/** Installed only by the RPC boundary after verifying the account identity. */
export class CatalogVisibility extends Context.Service<
	CatalogVisibility,
	{
		readonly chats: ReadonlySet<ChatId>;
		readonly projects: ReadonlySet<FolderId>;
		/** Omitted for read-only guest scopes. Populated only from verified grants. */
		readonly editableChats?: ReadonlySet<ChatId>;
	}
>()("zuse/collaboration/CatalogVisibility") {}

export class CatalogVisibilityChanges extends Context.Service<
	CatalogVisibilityChanges,
	Stream.Stream<CatalogVisibility["Service"]>
>()("zuse/collaboration/CatalogVisibilityChanges") {}

/** Reopen the existing snapshot/live feed whenever its authorized scope changes. */
export const withCatalogChanges = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
	Stream.unwrap(
		Effect.serviceOption(CatalogVisibilityChanges).pipe(
			Effect.map((changes) =>
				changes._tag === "None"
					? stream
					: changes.value.pipe(
							Stream.switchMap((scope) =>
								stream.pipe(Stream.provideService(CatalogVisibility, scope)),
							),
						),
			),
		),
	);

export const filterCatalog = <A>(
	items: ReadonlyArray<A>,
	visible: (scope: CatalogVisibility["Service"], item: A) => boolean,
) =>
	Effect.serviceOption(CatalogVisibility).pipe(
		Effect.map((scope) =>
			scope._tag === "None"
				? items
				: items.filter((item) => visible(scope.value, item)),
		),
	);

const scopedChat = (scope: CatalogVisibility["Service"], chat: Chat): Chat =>
	Chat.make({ ...chat, readOnly: !scope.editableChats?.has(chat.id) });

export const projectChatAccess = Effect.fn("projectChatAccess")(function* (
	chat: Chat,
) {
	const scope = yield* Effect.serviceOption(CatalogVisibility);
	return scope._tag === "None" ? chat : scopedChat(scope.value, chat);
});

export const filterChats = Effect.fn("filterChats")(function* (
	chats: ReadonlyArray<Chat>,
) {
	const scope = yield* Effect.serviceOption(CatalogVisibility);
	return scope._tag === "None"
		? chats
		: chats
				.filter((chat) => scope.value.chats.has(chat.id))
				.map((chat) => scopedChat(scope.value, chat));
});

export const filterChatCatalog = <E, R>(
	stream: Stream.Stream<ChatSummaryChange, E, R>,
) =>
	Stream.unwrap(
		Effect.serviceOption(CatalogVisibility).pipe(
			Effect.map((scope) =>
				scope._tag === "None"
					? stream
					: stream.pipe(
							Stream.filterMap(
								(change): Result.Result<ChatSummaryChange, undefined> => {
									if (change._tag === "snapshot")
										return Result.succeed({
											...change,
											chats: change.chats
												.filter((chat) => scope.value.chats.has(chat.id))
												.map((chat) => scopedChat(scope.value, chat)),
										});
									return scope.value.chats.has(change.chat.id)
										? Result.succeed({
												...change,
												chat: scopedChat(scope.value, change.chat),
											})
										: Result.fail(undefined);
								},
							),
						),
			),
		),
	);

export const filterSessionCatalog = <E, R>(
	stream: Stream.Stream<SessionSummaryChange, E, R>,
) =>
	Stream.unwrap(
		Effect.serviceOption(CatalogVisibility).pipe(
			Effect.map((scope) => {
				if (scope._tag === "None") return stream;
				const known = new Set<SessionId>();
				return stream.pipe(
					Stream.filterMap(
						(change): Result.Result<SessionSummaryChange, undefined> => {
							if (change._tag === "snapshot") {
								known.clear();
								const sessions = change.sessions.filter((session) =>
									scope.value.chats.has(session.chatId),
								);
								for (const session of sessions) known.add(session.id);
								return Result.succeed({ ...change, sessions });
							}
							if (change._tag === "remove")
								return known.delete(change.sessionId)
									? Result.succeed(change)
									: Result.fail(undefined);
							if (scope.value.chats.has(change.session.chatId)) {
								known.add(change.session.id);
								return Result.succeed(change);
							}
							// If a previously visible session moves out of scope, remove its
							// old row without revealing the destination or updated contents.
							return known.delete(change.session.id)
								? Result.succeed({
										_tag: "remove",
										sequence: change.sequence,
										sessionId: change.session.id,
									})
								: Result.fail(undefined);
						},
					),
				);
			}),
		),
	);
