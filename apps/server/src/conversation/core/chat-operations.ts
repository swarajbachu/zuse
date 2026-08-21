import {
	type Chat,
	type ChatId,
	ChatNotArchivedError,
	ChatNotFoundError,
	type FolderId,
} from "@zuse/contracts";
import type { ChatCommand } from "@zuse/domain/chat/commands";
import { Effect, PubSub, Stream } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type {
	ConversationOperations,
	CreateChatInput,
} from "../services/conversation-services.ts";
import type { ChatChangeEvent } from "./chat-change-event.ts";
import {
	type ChatRow,
	chatFromRow,
	type MessageRow,
	messageFromRow,
	type SessionRow,
	sessionFromRow,
} from "./conversation-records.ts";

export interface ChatOperationsOptions {
	readonly sql: SqlClient.SqlClient;
	readonly currentTimestamp: Effect.Effect<number>;
	readonly createSession: ConversationOperations["createSession"];
	readonly broadcastChat: (chat: Chat) => Effect.Effect<void>;
	readonly chatChangesHub: PubSub.PubSub<ChatChangeEvent>;
	readonly currentChatRevision: () => number;
	readonly dispatchChatCommand: (
		chatId: ChatId,
		command: ChatCommand,
		commandId?: string,
	) => Effect.Effect<void>;
}

const sameTimestamp = (left: Date | null, right: Date | null): boolean =>
	left?.getTime() === right?.getTime();

const sameChatSummary = (left: Chat, right: Chat): boolean =>
	left.id === right.id &&
	left.projectId === right.projectId &&
	left.worktreeId === right.worktreeId &&
	left.title === right.title &&
	left.titleProvenance === right.titleProvenance &&
	left.activeSessionId === right.activeSessionId &&
	left.originSessionId === right.originSessionId &&
	sameTimestamp(left.archivedAt, right.archivedAt) &&
	sameTimestamp(left.lastMessageAt, right.lastMessageAt) &&
	sameTimestamp(left.lastReadAt, right.lastReadAt) &&
	left.createdAt.getTime() === right.createdAt.getTime() &&
	left.updatedAt.getTime() === right.updatedAt.getTime();

const sameChatCatalog = (
	left: ReadonlyArray<Chat>,
	right: ReadonlyArray<Chat>,
): boolean => {
	if (left.length !== right.length) return false;
	const rightById = new Map(right.map((chat) => [chat.id, chat]));
	return left.every((chat) => {
		const candidate = rightById.get(chat.id);
		return candidate !== undefined && sameChatSummary(chat, candidate);
	});
};

interface BootstrapReceiptRow {
	readonly stream_id: string;
	readonly payload_json: string;
}

const chatsByProject = (
	chats: ReadonlyArray<Chat>,
): ReadonlyMap<FolderId, ReadonlyArray<Chat>> => {
	const grouped = new Map<FolderId, Chat[]>();
	for (const chat of chats) {
		const projectChats = grouped.get(chat.projectId);
		if (projectChats === undefined) grouped.set(chat.projectId, [chat]);
		else projectChats.push(chat);
	}
	return grouped;
};

export const makeChatOperations = (options: ChatOperationsOptions) => {
	const {
		sql,
		currentTimestamp,
		createSession,
		broadcastChat,
		chatChangesHub,
		currentChatRevision,
		dispatchChatCommand,
	} = options;
	const lookupChat = (chatId: ChatId): Effect.Effect<Chat, ChatNotFoundError> =>
		Effect.gen(function* () {
			const rows = yield* sql<ChatRow>`
          SELECT id, project_id, worktree_id, title, title_provenance, active_session_id, origin_session_id,
                 archived_at, archived_worktree_json, last_message_at, last_read_at, created_at, updated_at
          FROM chats WHERE id = ${chatId} LIMIT 1
        `.pipe(Effect.orDie);
			const [row] = rows;
			if (row === undefined) {
				return yield* Effect.fail(new ChatNotFoundError({ chatId }));
			}
			return chatFromRow(row);
		});

	const listChats: ConversationOperations["listChats"] = (
		projectId,
		includeArchived,
	) =>
		Effect.gen(function* () {
			const rows = includeArchived
				? yield* sql<ChatRow>`
              SELECT id, project_id, worktree_id, title, title_provenance, active_session_id, origin_session_id,
                     archived_at, archived_worktree_json, last_message_at, last_read_at, created_at, updated_at
              FROM chats WHERE project_id = ${projectId}
              ORDER BY updated_at DESC
            `.pipe(Effect.orDie)
				: yield* sql<ChatRow>`
              SELECT id, project_id, worktree_id, title, title_provenance, active_session_id, origin_session_id,
                     archived_at, archived_worktree_json, last_message_at, last_read_at, created_at, updated_at
              FROM chats
              WHERE project_id = ${projectId} AND archived_at IS NULL
              ORDER BY updated_at DESC
            `.pipe(Effect.orDie);
			return rows.map(chatFromRow);
		});

	const listAllChats = Effect.fn("ChatOperations.listAllChats")(function* () {
		const rows = yield* sql<ChatRow>`
			SELECT id, project_id, worktree_id, title, title_provenance, active_session_id, origin_session_id,
			       archived_at, archived_worktree_json, last_message_at, last_read_at, created_at, updated_at
			FROM chats
			WHERE archived_at IS NULL
			ORDER BY project_id ASC, updated_at DESC, id ASC
		`;
		return rows.map(chatFromRow);
	});

	const readCatalogRevision = Effect.fn("ChatOperations.readCatalogRevision")(
		function* () {
			const rows = yield* sql<{ readonly revision: number }>`
				SELECT revision FROM chat_catalog_revision WHERE id = 1
			`;
			return rows[0]?.revision ?? 0;
		},
	);

	const getChat: ConversationOperations["getChat"] = (chatId) =>
		lookupChat(chatId);

	const getArchivePreview: ConversationOperations["getArchivePreview"] =
		Effect.fn("ChatOperations.getArchivePreview")(function* (chatId) {
			const chat = yield* lookupChat(chatId);
			if (chat.archivedAt === null) {
				return yield* new ChatNotArchivedError({ chatId });
			}
			const rows = yield* sql<SessionRow>`
        SELECT id, project_id, title, title_provenance, provider_id, model, status,
               archived_at, cursor, resume_strategy, runtime_mode,
               agents_json, worktree_id, chat_id, forked_from_session_id,
               forked_from_message_id, permission_mode, tool_search,
               created_at, updated_at
        FROM sessions
        WHERE chat_id = ${chatId}
        ORDER BY created_at ASC
      `.pipe(Effect.orDie);
			return { chat, sessions: rows.map(sessionFromRow) };
		});

	const lookupInitialMessage = (sessionId: string) =>
		sql<MessageRow>`
			SELECT id, session_id, role, kind, content_json, parent_item_id, created_at
			FROM messages
			WHERE session_id = ${sessionId} AND role = 'user'
			ORDER BY created_at ASC
			LIMIT 1
		`.pipe(
			Effect.orDie,
			Effect.map((rows) => {
				const [row] = rows;
				return row === undefined ? null : messageFromRow(row);
			}),
		);

	const streamChatChanges: ConversationOperations["streamChatChanges"] = (
		projectId,
	) =>
		Stream.unwrap(
			Effect.gen(function* () {
				const sub = yield* PubSub.subscribe(chatChangesHub);
				// Subscribe before reading the snapshot. A mutation that lands during
				// the query is present in the snapshot, queued in the subscription, or
				// both; the ordered concat ensures a queued fresh patch always lands
				// after the possibly older snapshot.
				const snapshot = yield* listChats(projectId, false);
				const live = Stream.fromSubscription(sub).pipe(
					Stream.filter((event) => event.projectId === projectId),
					Stream.map((event) => event.change),
				);
				return Stream.concat(
					Stream.succeed({
						_tag: "snapshot" as const,
						chats: snapshot,
					}),
					live,
				);
			}),
		);

	const runChatReconciliation = Effect.fn(
		"ChatOperations.runChatReconciliation",
	)(function* () {
		let previous: ReadonlyMap<FolderId, ReadonlyArray<Chat>> = new Map();
		let previousCatalogRevision: number | null = null;
		yield* Effect.forever(
			Effect.gen(function* () {
				const catalogRevisionResult = yield* readCatalogRevision().pipe(
					Effect.result,
				);
				if (catalogRevisionResult._tag === "Failure") {
					yield* Effect.logWarning(
						"Chat reconciliation revision query failed; retrying",
					).pipe(Effect.annotateLogs("error", catalogRevisionResult.failure));
					yield* Effect.sleep("1 second");
					return;
				}
				const catalogRevision = catalogRevisionResult.success;
				if (previousCatalogRevision === catalogRevision) {
					yield* Effect.sleep("1 second");
					return;
				}
				const revision = currentChatRevision();
				const result = yield* listAllChats().pipe(Effect.result);
				if (result._tag === "Failure") {
					yield* Effect.logWarning(
						"Chat reconciliation query failed; retrying",
					).pipe(Effect.annotateLogs("error", result.failure));
					yield* Effect.sleep("1 second");
					return;
				}
				const current = chatsByProject(result.success);
				// A local mutation published a precise patch while the catalog query
				// was in flight. Discard this potentially older snapshot; the next
				// pass will reconcile from the durable state.
				yield* Effect.sync(() => {
					if (currentChatRevision() !== revision) return;
					const projectIds = new Set([...previous.keys(), ...current.keys()]);
					for (const projectId of projectIds) {
						const before = previous.get(projectId) ?? [];
						const after = current.get(projectId) ?? [];
						if (sameChatCatalog(before, after)) continue;
						PubSub.publishUnsafe(chatChangesHub, {
							projectId,
							change: { _tag: "snapshot", chats: after },
						});
					}
					previous = current;
					previousCatalogRevision = catalogRevision;
				});
				yield* Effect.sleep("1 second");
			}),
		);
	});

	/**
	 * Create a chat row AND its initial session in one effect. Both rows
	 * land or neither does — we INSERT the chat first, attempt the
	 * provider boot, and if the boot fails we DELETE the chat to leave
	 * the DB clean.
	 */
	const createChat: ConversationOperations["createChat"] = (
		input: CreateChatInput,
	) =>
		Effect.gen(function* () {
			const createdAt = yield* currentTimestamp;
			const chatId = input.chatId ?? (crypto.randomUUID() as unknown as ChatId);
			if (input.chatId !== undefined && input.initialSessionId !== undefined) {
				const existingSessions = yield* sql<SessionRow>`
					SELECT id, project_id, title, title_provenance, provider_id, model, status,
					       archived_at, cursor, resume_strategy, runtime_mode,
					       agents_json, worktree_id, chat_id, forked_from_session_id,
					       forked_from_message_id, permission_mode, tool_search,
					       created_at, updated_at
					FROM sessions
					WHERE id = ${input.initialSessionId} AND chat_id = ${input.chatId}
					LIMIT 1
				`.pipe(Effect.orDie);
				const [existingSessionRow] = existingSessions;
				if (existingSessionRow !== undefined) {
					if (input.commandId !== undefined) {
						const receipts = yield* sql<BootstrapReceiptRow>`
							SELECT receipt.stream_id, event.payload_json
							FROM command_receipts receipt
							INNER JOIN events event
								ON event.event_id = json_extract(receipt.event_ids_json, '$[0]')
							WHERE receipt.command_id = ${input.commandId}
							LIMIT 1
						`.pipe(Effect.orDie);
						const receipt = receipts[0];
						const hasDurableReceipt = receipt !== undefined;
						// Compatibility for sessions created before chat bootstrap receipts
						// existed. Exact entity identity and configuration are sufficient to
						// prove this replay cannot create a second session. A present receipt
						// remains authoritative and must match in full.
						let receiptMatches =
							receipt === undefined &&
							existingSessionRow.project_id === input.projectId &&
							existingSessionRow.provider_id === input.providerId &&
							existingSessionRow.model === input.model;
						if (receipt !== undefined) {
							try {
								const created = JSON.parse(receipt.payload_json) as Record<
									string,
									unknown
								>;
								receiptMatches =
									receipt.stream_id === input.initialSessionId &&
									created._tag === "SessionCreated" &&
									created.sessionId === input.initialSessionId &&
									created.chatId === input.chatId &&
									created.providerId === input.providerId &&
									created.model === input.model;
							} catch {
								receiptMatches = false;
							}
						}
						if (!receiptMatches) {
							return yield* Effect.die(
								new Error(
									`chat bootstrap command ${input.commandId} conflicts with its durable receipt`,
								),
							);
						}
						if (
							input.initialPrompt !== undefined &&
							input.initialPrompt.trim().length > 0
						) {
							const messages = yield* sql<{
								readonly id: string;
								readonly content_json: string;
							}>`
								SELECT id, content_json FROM messages
								WHERE session_id = ${input.initialSessionId} AND role = 'user'
								ORDER BY sequence ASC LIMIT 1
							`.pipe(Effect.orDie);
							const message = messages[0];
							let messageMatches = false;
							if (message !== undefined) {
								try {
									const content = JSON.parse(message.content_json) as Record<
										string,
										unknown
									>;
									messageMatches =
										(input.initialMessageId === undefined ||
											!hasDurableReceipt ||
											message.id === input.initialMessageId) &&
										content.text === input.initialPrompt;
								} catch {
									messageMatches = false;
								}
							}
							if (!messageMatches) {
								return yield* Effect.die(
									new Error(
										`chat bootstrap command ${input.commandId} conflicts with its durable prompt`,
									),
								);
							}
						}
					}
					const existingChat = yield* lookupChat(input.chatId).pipe(
						Effect.orDie,
					);
					const initialMessage = yield* lookupInitialMessage(
						input.initialSessionId,
					);
					return {
						chat: existingChat,
						initialSession: sessionFromRow(existingSessionRow),
						initialMessage,
					};
				}
			}
			const title = input.title?.trim() || "New chat";
			const worktreeId = input.worktreeId ?? null;
			const originSessionId = input.originSessionId ?? null;
			yield* dispatchChatCommand(chatId, {
				_tag: "CreateChat",
				chatId,
				projectId: input.projectId,
				worktreeId,
				title,
				titleProvenance: input.title?.trim() ? "manual" : "pending",
				originSessionId,
				lastReadAt: createdAt,
				createdAt,
			});
			const initialSession = yield* createSession({
				sessionId: input.initialSessionId,
				commandId: input.commandId,
				initialTurnId: input.initialTurnId,
				initialMessageId: input.initialMessageId,
				chatId,
				providerId: input.providerId,
				model: input.model,
				title: input.title,
				initialPrompt: input.initialPrompt,
				runtimeMode: input.runtimeMode,
				agents: input.agents,
				enableSubagents: input.enableSubagents,
				permissionMode: input.permissionMode,
				modelOptions: input.modelOptions,
				toolSearch: input.toolSearch,
				queuePaused: input.queuePaused,
				resumeCursor: input.resumeCursor,
				resumeStrategy: input.resumeStrategy,
				forkedFromSessionId: input.forkedFromSessionId,
				forkedFromMessageId: input.forkedFromMessageId,
				forkFromResume: input.forkFromResume,
				background: input.background,
			}).pipe(
				Effect.tapError(() =>
					// Roll back the chat row if the provider failed to boot —
					// otherwise the sidebar would show an empty container the
					// user can't escape from.
					dispatchChatCommand(chatId, {
						_tag: "DeleteChat",
						deletedAt: createdAt,
					}),
				),
			);
			const chat = yield* lookupChat(chatId).pipe(Effect.orDie);
			yield* broadcastChat(chat);
			// Fetch the initial user message (if any) so the renderer can seed
			// its messages store and skip the empty-state flash while the live
			// message stream is connecting. `createSession` writes the row
			// synchronously when `initialPrompt` is supplied, so by here it
			// exists in the table.
			const hasInitial =
				input.initialPrompt !== undefined &&
				input.initialPrompt.trim().length > 0;
			const initialMessage = hasInitial
				? yield* lookupInitialMessage(initialSession.id)
				: null;
			return { chat, initialSession, initialMessage };
		});

	return {
		lookupChat,
		listChats,
		getChat,
		getArchivePreview,
		streamChatChanges,
		runChatReconciliation,
		createChat,
	};
};
