import { type Chat, type ChatId, ChatNotFoundError } from "@zuse/contracts";
import type { ChatCommand } from "@zuse/domain/chat/commands";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type {
	ConversationOperations,
	CreateChatInput,
} from "../services/conversation-services.ts";
import { deriveProvisionalTitle } from "./conversation-input.ts";
import {
	type ChatRow,
	chatFromRow,
	type MessageRow,
	messageFromRow,
} from "./conversation-records.ts";

export interface ChatOperationsOptions {
	readonly sql: SqlClient.SqlClient;
	readonly currentTimestamp: Effect.Effect<number>;
	readonly createSession: ConversationOperations["createSession"];
	readonly broadcastChat: (chat: Chat) => Effect.Effect<void>;
	readonly dispatchChatCommand: (
		chatId: ChatId,
		command: ChatCommand,
		commandId?: string,
	) => Effect.Effect<void>;
}

export const makeChatOperations = (options: ChatOperationsOptions) => {
	const {
		sql,
		currentTimestamp,
		createSession,
		broadcastChat,
		dispatchChatCommand,
	} = options;
	const lookupChat = (chatId: ChatId): Effect.Effect<Chat, ChatNotFoundError> =>
		Effect.gen(function* () {
			const rows = yield* sql<ChatRow>`
          SELECT id, project_id, worktree_id, title, active_session_id, origin_session_id,
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
              SELECT id, project_id, worktree_id, title, active_session_id, origin_session_id,
                     archived_at, archived_worktree_json, last_message_at, last_read_at, created_at, updated_at
              FROM chats WHERE project_id = ${projectId}
              ORDER BY updated_at DESC
            `.pipe(Effect.orDie)
				: yield* sql<ChatRow>`
              SELECT id, project_id, worktree_id, title, active_session_id, origin_session_id,
                     archived_at, archived_worktree_json, last_message_at, last_read_at, created_at, updated_at
              FROM chats
              WHERE project_id = ${projectId} AND archived_at IS NULL
              ORDER BY updated_at DESC
            `.pipe(Effect.orDie);
			return rows.map(chatFromRow);
		});

	const getChat: ConversationOperations["getChat"] = (chatId) =>
		lookupChat(chatId);

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
			const chatId = crypto.randomUUID() as unknown as ChatId;
			const title =
				input.title?.trim() || deriveProvisionalTitle(input.initialPrompt);
			const worktreeId = input.worktreeId ?? null;
			const originSessionId = input.originSessionId ?? null;
			yield* dispatchChatCommand(chatId, {
				_tag: "CreateChat",
				chatId,
				projectId: input.projectId,
				worktreeId,
				title,
				originSessionId,
				lastReadAt: createdAt,
				createdAt,
			});
			const initialSession = yield* createSession({
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
				resumeCursor: input.resumeCursor,
				resumeStrategy: input.resumeStrategy,
				forkedFromSessionId: input.forkedFromSessionId,
				forkedFromMessageId: input.forkedFromMessageId,
				forkFromResume: input.forkFromResume,
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
				? yield* sql<MessageRow>`
              SELECT id, session_id, role, kind, content_json, parent_item_id, created_at
              FROM messages
              WHERE session_id = ${initialSession.id} AND role = 'user'
              ORDER BY created_at ASC
              LIMIT 1
            `.pipe(
						Effect.orDie,
						Effect.map((rows) => {
							const [row] = rows;
							return row === undefined ? null : messageFromRow(row);
						}),
					)
				: null;
			yield* broadcastChat(chat);
			return { chat, initialSession, initialMessage };
		});

	return { lookupChat, listChats, getChat, createChat };
};
