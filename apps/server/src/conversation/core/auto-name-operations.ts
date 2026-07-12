import {
	type Chat,
	type ChatId,
	type MessageContent,
	SessionId,
} from "@zuse/contracts";
import type { ChatCommand } from "@zuse/domain/chat/commands";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import type { GitServiceShape } from "@zuse/git/git-service";
import type { WorktreeServiceShape } from "@zuse/git/worktree-service";
import { Effect, PubSub, Stream } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { ConfigStoreServiceShape } from "../../config-store/services/config-store-service.ts";
import type { makeReactorEffectJournal } from "../../provider/reactor-effect-journal.ts";
import type { TitleGeneratorShape } from "../../provider/title-generator.ts";
import {
	buildConversationText,
	formatBranchName,
	shouldDeferAutoName,
} from "../../provider/title-generator.ts";
import type { ConversationOperations } from "../services/conversation-services.ts";
import { textFromMessageContent } from "./conversation-input.ts";

export interface AutoNameOperationsOptions {
	readonly sql: SqlClient.SqlClient;
	readonly currentTimestamp: Effect.Effect<number>;
	readonly dispatchChatCommand: (
		chatId: ChatId,
		command: ChatCommand,
		commandId?: string,
	) => Effect.Effect<void>;
	readonly lookupChat: ConversationOperations["getChat"];
	readonly lookupSession: ConversationOperations["getSession"];
	readonly broadcastChat: (chat: Chat) => Effect.Effect<void>;
	readonly chatChangesHub: PubSub.PubSub<Chat>;
	readonly reactorEffects: ReturnType<typeof makeReactorEffectJournal>;
	readonly titleGen: TitleGeneratorShape;
	readonly sessionDomain: SessionDomainApi;
	readonly worktrees: WorktreeServiceShape;
	readonly git: GitServiceShape;
	readonly configStore: ConfigStoreServiceShape;
}

export const makeAutoNameOperations = (options: AutoNameOperationsOptions) => {
	const {
		sql,
		currentTimestamp,
		dispatchChatCommand,
		lookupChat,
		lookupSession,
		broadcastChat,
		chatChangesHub,
		reactorEffects,
		titleGen,
		sessionDomain,
		worktrees,
		git,
		configStore,
	} = options;
	const renameChatWithCommandId = (
		chatId: ChatId,
		title: string,
		commandId: string,
	) =>
		Effect.gen(function* () {
			yield* lookupChat(chatId);
			yield* dispatchChatCommand(
				chatId,
				{
					_tag: "RenameChat",
					title,
					updatedAt: yield* currentTimestamp,
				},
				commandId,
			);
			// Push the new title to any renderer subscribed via
			// `chat.streamChanges` so the sidebar updates without a refetch.
			const updated = yield* lookupChat(chatId);
			yield* broadcastChat(updated);
		});

	const renameChat: ConversationOperations["renameChat"] = (chatId, title) =>
		renameChatWithCommandId(chatId, title, crypto.randomUUID());

	const markChatRead: ConversationOperations["markChatRead"] = (chatId) =>
		Effect.gen(function* () {
			yield* lookupChat(chatId);
			yield* dispatchChatCommand(chatId, {
				_tag: "MarkChatRead",
				readAt: yield* currentTimestamp,
			});
			return yield* lookupChat(chatId);
		});

	const streamChatChanges: ConversationOperations["streamChatChanges"] = (
		projectId,
	) =>
		Stream.unwrap(
			Effect.gen(function* () {
				const sub = yield* PubSub.subscribe(chatChangesHub);
				return Stream.fromSubscription(sub).pipe(
					Stream.filter((chat) => chat.projectId === projectId),
				);
			}),
		);

	/**
	 * LLM auto-name: summarize recent user/assistant turns into a short title
	 * and rename the chat (always) plus the worktree git branch (when the chat
	 * has its own worktree). Runs on a background fiber so the agent turn is
	 * never delayed; swallows every failure so a flaky title call can't wedge
	 * the session.
	 */
	const collectAutoNameContext = (
		chatId: ChatId,
	): Effect.Effect<{
		readonly userTexts: string[];
		readonly assistantTexts: string[];
		readonly conversationText: string;
	}> =>
		Effect.gen(function* () {
			const rows = yield* sql<{
				readonly role: string;
				readonly content_json: string;
			}>`
          SELECT m.role, m.content_json
          FROM messages m
          INNER JOIN sessions s ON s.id = m.session_id
          WHERE s.chat_id = ${chatId}
            AND m.role IN ('user', 'assistant')
          ORDER BY m.created_at ASC
          LIMIT 24
        `.pipe(Effect.orDie);
			const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
			const userTexts: string[] = [];
			const assistantTexts: string[] = [];
			for (const row of rows) {
				try {
					const content = JSON.parse(row.content_json) as MessageContent;
					const text = textFromMessageContent(content);
					if (text === null || text.trim().length === 0) continue;
					if (row.role === "user") {
						userTexts.push(text);
						turns.push({ role: "user", text });
					} else if (row.role === "assistant") {
						assistantTexts.push(text);
						turns.push({ role: "assistant", text });
					}
				} catch {
					// Skip malformed rows — title gen can still fall back.
				}
			}
			return {
				userTexts,
				assistantTexts,
				conversationText: buildConversationText(turns),
			};
		});

	const autoNameChat = (
		chatId: ChatId,
		sessionId: SessionId,
		commandId: string,
	): Effect.Effect<void> =>
		Effect.gen(function* () {
			if (yield* reactorEffects.isCompleted(commandId)) return;
			const chat = yield* lookupChat(chatId).pipe(
				Effect.catch(() => Effect.succeed(null)),
			);
			if (chat === null) return;

			const context = yield* collectAutoNameContext(chatId);
			if (shouldDeferAutoName(context.userTexts, context.assistantTexts)) {
				return;
			}

			const session = yield* lookupSession(sessionId).pipe(
				Effect.catch(() => Effect.succeed(null)),
			);
			if (session === null) return;
			const title = yield* titleGen.generate({
				folderId: chat.projectId,
				providerId: session.providerId,
				model: session.model,
				conversationText: context.conversationText,
			});
			if (title.length === 0 || title === "New chat") return;

			// Title first — cheap, and the user sees the sidebar update even if
			// the branch rename below is skipped or fails.
			yield* renameChatWithCommandId(chatId, title, commandId);
			const memberSessions = yield* sql<{ readonly id: string }>`
          SELECT id FROM sessions WHERE chat_id = ${chatId}
        `.pipe(Effect.orDie);
			yield* Effect.forEach(
				memberSessions,
				({ id }) =>
					Effect.gen(function* () {
						yield* sessionDomain.dispatch({
							commandId: `${commandId}:session:${id}`,
							streamId: SessionId.make(id),
							command: {
								_tag: "SetTitle",
								title,
								updatedAt: yield* currentTimestamp,
							},
						});
					}).pipe(Effect.ignore),
				{ discard: true },
			);

			const markComplete = reactorEffects.complete(commandId);
			if (chat.worktreeId === null) {
				yield* markComplete;
				return;
			}
			const worktreeId = chat.worktreeId;
			const wt = yield* worktrees.get(worktreeId);
			if (wt === null) {
				yield* markComplete;
				return;
			}

			const settings = yield* configStore.getSettings();
			const username = yield* git
				.getUserName(chat.projectId)
				.pipe(Effect.catch(() => Effect.succeed("")));
			const branch = formatBranchName(
				title,
				username,
				settings.branchNamingStyle,
				settings.branchNamingPrefix,
			);
			// Rename the git branch, then mirror it onto the worktree row so the
			// DB and git agree. updateBranch only runs if the rename succeeded.
			yield* git.renameBranch(chat.projectId, branch, worktreeId).pipe(
				Effect.flatMap(() => worktrees.updateBranch(worktreeId, branch)),
				Effect.catch(() => Effect.void),
			);

			yield* markComplete;
		}).pipe(Effect.catchCause(() => Effect.void));

	return {
		renameChatWithCommandId,
		renameChat,
		markChatRead,
		streamChatChanges,
		autoNameChat,
	};
};
