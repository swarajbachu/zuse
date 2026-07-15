import {
	type Chat,
	type Message,
	type MessageContent,
	type ResumeStrategy,
	type Session,
	SessionStartError,
} from "@zuse/contracts";
import { proposedPlanMarkdownFromContent } from "@zuse/utils/proposed-plan";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type {
	ConversationOperations,
	TranscriptServiceShape,
} from "../services/conversation-services.ts";
import {
	shouldIncludeInTranscript,
	transcriptToMarkdown,
} from "./conversation-message-mapping.ts";
import { type MessageRow, messageFromRow } from "./conversation-records.ts";

interface PersistedMessage {
	readonly message: Message;
	readonly sequence: number;
}

export interface TranscriptOperationsOptions {
	readonly sql: SqlClient.SqlClient;
	readonly createChat: ConversationOperations["createChat"];
	readonly createSession: ConversationOperations["createSession"];
	readonly lookupChat: ConversationOperations["getChat"];
	readonly lookupSession: ConversationOperations["getSession"];
	readonly persistMessage: (
		sessionId: Parameters<ConversationOperations["getSession"]>[0],
		content: MessageContent,
	) => Effect.Effect<PersistedMessage>;
}

export const makeTranscriptOperations = (
	options: TranscriptOperationsOptions,
): TranscriptServiceShape => {
	const {
		sql,
		createChat,
		createSession,
		lookupChat,
		lookupSession,
		persistMessage,
	} = options;

	const continueExternalThread: ConversationOperations["continueExternalThread"] =
		(input) =>
			Effect.gen(function* () {
				const result = yield* createChat({
					...input,
					resumeCursor: input.resumeCursor,
					resumeStrategy: input.resumeStrategy,
				});
				return {
					chat: result.chat,
					initialSession: result.initialSession,
				};
			});

	const importExternalMessages: ConversationOperations["importExternalMessages"] =
		(sessionId, messages) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				const imported: Message[] = [];
				for (const content of messages) {
					const persisted = yield* persistMessage(sessionId, content);
					imported.push(persisted.message);
				}
				return imported;
			});

	const exportTranscript: ConversationOperations["exportTranscript"] = (
		sessionId,
		uptoMessageId,
	) =>
		Effect.gen(function* () {
			const session = yield* lookupSession(sessionId);
			const rows = yield* sql<MessageRow>`
				SELECT id, session_id, role, kind, content_json, parent_item_id, created_at
				FROM messages WHERE session_id = ${sessionId}
				ORDER BY created_at ASC, sequence ASC
			`.pipe(Effect.orDie);
			let slice = rows;
			if (uptoMessageId !== undefined) {
				const index = rows.findIndex((row) => row.id === uptoMessageId);
				if (index !== -1) slice = rows.slice(0, index + 1);
			}
			return transcriptToMarkdown(session.title, slice.map(messageFromRow));
		});

	const latestPlan: ConversationOperations["latestPlan"] = (sessionId) =>
		Effect.gen(function* () {
			const session = yield* lookupSession(sessionId);
			const rows = yield* sql<MessageRow>`
				SELECT id, session_id, role, kind, content_json, parent_item_id, created_at
				FROM messages
				WHERE session_id = ${sessionId} AND kind IN ('tool_use', 'assistant')
				ORDER BY created_at DESC, sequence DESC
			`.pipe(Effect.orDie);
			for (const row of rows) {
				const content = messageFromRow(row).content;
				const markdown = proposedPlanMarkdownFromContent(content);
				if (markdown !== null) return markdown;
				// Compatibility for plan items persisted before providers preserved
				// their semantic marker. Codex remains in plan mode while the final
				// plan awaits feedback, and its newest assistant row is that plan.
				if (
					session.providerId === "codex" &&
					session.permissionMode === "plan" &&
					content._tag === "assistant" &&
					content.text.trim().length > 0
				) {
					return content.text.trim();
				}
			}
			return null;
		});

	const forkSession: ConversationOperations["forkSession"] = (input) =>
		Effect.gen(function* () {
			const source = yield* lookupSession(input.sourceSessionId);
			const rows = yield* sql<MessageRow>`
				SELECT id, session_id, role, kind, content_json, parent_item_id, created_at
				FROM messages WHERE session_id = ${input.sourceSessionId}
				ORDER BY created_at ASC, sequence ASC
			`.pipe(Effect.orDie);
			const forkIndex = rows.findIndex((row) => row.id === input.fromMessageId);
			if (forkIndex === -1) {
				return yield* Effect.fail(
					new SessionStartError({
						providerId: source.providerId,
						reason: `fork message ${input.fromMessageId} not found in session ${input.sourceSessionId}`,
					}),
				);
			}

			const providerId = input.providerId ?? source.providerId;
			const model = input.model ?? source.model;
			const isTail = forkIndex === rows.length - 1;
			const providerCanFork = providerId === "claude" || providerId === "codex";
			const forkMode: "resume" | "copy" =
				isTail &&
				providerId === source.providerId &&
				providerCanFork &&
				source.cursor !== null &&
				source.resumeStrategy !== "none"
					? "resume"
					: "copy";
			const title =
				input.title?.trim() || `Fork of ${source.title}`.slice(0, 120);
			const transcript = rows
				.slice(0, forkIndex + 1)
				.map(messageFromRow)
				.filter((message) => shouldIncludeInTranscript(message.content))
				.map((message) => message.content);
			const resumeCursor = forkMode === "resume" ? source.cursor : null;
			const resumeStrategy: ResumeStrategy =
				forkMode === "resume" ? source.resumeStrategy : "none";

			let chat: Chat;
			let session: Session;
			if (input.destination === "tab") {
				session = yield* createSession({
					chatId: source.chatId,
					providerId,
					model,
					title,
					runtimeMode: source.runtimeMode,
					permissionMode: source.permissionMode,
					toolSearch: source.toolSearch,
					background: true,
					resumeCursor,
					resumeStrategy,
					forkedFromSessionId: input.sourceSessionId,
					forkedFromMessageId: input.fromMessageId,
					forkFromResume: forkMode === "resume",
				});
				chat = yield* lookupChat(source.chatId).pipe(Effect.orDie);
			} else {
				const created = yield* createChat({
					projectId: source.projectId,
					providerId,
					model,
					title,
					worktreeId: input.worktreeId ?? null,
					runtimeMode: source.runtimeMode,
					permissionMode: source.permissionMode,
					toolSearch: source.toolSearch,
					resumeCursor,
					resumeStrategy,
					forkedFromSessionId: input.sourceSessionId,
					forkedFromMessageId: input.fromMessageId,
					forkFromResume: forkMode === "resume",
				});
				chat = created.chat;
				session = created.initialSession;
			}
			if (transcript.length > 0) {
				yield* importExternalMessages(session.id, transcript).pipe(
					Effect.catch(() => Effect.succeed([])),
				);
			}
			return { chat, session, forkMode };
		});

	return {
		continueExternalThread,
		importExternalMessages,
		forkSession,
		exportTranscript,
		latestPlan,
	};
};
