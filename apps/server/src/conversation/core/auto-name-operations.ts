import type { Chat, ChatId, MessageContent, SessionId } from "@zuse/contracts";
import type { ChatCommand } from "@zuse/domain/chat/commands";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import type { GitServiceShape } from "@zuse/git/git-service";
import type { WorktreeServiceShape } from "@zuse/git/worktree-service";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { ConfigStoreServiceShape } from "../../config-store/services/config-store-service.ts";
import type { makeReactorEffectJournal } from "../../provider/reactor-effect-journal.ts";
import type { TitleGeneratorShape } from "../../provider/title-generator.ts";
import {
	buildConversationText,
	formatBranchName,
} from "../../provider/title-generator.ts";
import type { ConversationOperations } from "../services/conversation-services.ts";
import { textFromMessageContent } from "./conversation-input.ts";

export interface QualifiedNamingTurn {
	readonly userText: string;
	readonly conversationText: string;
}

export const qualifyNamingMessage = (
	contentJson: string,
): QualifiedNamingTurn | null => {
	try {
		const content = JSON.parse(contentJson) as MessageContent;
		const userText = textFromMessageContent(content)?.trim() ?? "";
		if (
			userText.length === 0 ||
			(content._tag !== "user" && content._tag !== "user_rich")
		) {
			return null;
		}
		return {
			userText,
			conversationText: buildConversationText([
				{ role: "user", text: userText },
			]),
		};
	} catch {
		return null;
	}
};

interface FirstNamingMessageRow {
	readonly turn_id: string;
	readonly content_json: string;
}

/** Only the session's first user turn is eligible for automatic naming. */
export const qualifyTurnForNaming = Effect.fn("qualifyTurnForNaming")(
	function* (
		sql: SqlClient.SqlClient,
		sessionId: SessionId,
		turnId: string,
	): Effect.fn.Return<QualifiedNamingTurn | null> {
		const rows = yield* sql<FirstNamingMessageRow>`
			SELECT turn_id, content_json
			FROM messages
			WHERE session_id = ${sessionId}
				AND role = 'user'
				AND turn_id IS NOT NULL
			ORDER BY sequence ASC
			LIMIT 1
		`.pipe(Effect.orDie);
		const first = rows[0];
		return first?.turn_id === turnId
			? qualifyNamingMessage(first.content_json)
			: null;
	},
);

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
		titleProvenance: "automatic" | "manual" = "manual",
	) =>
		Effect.gen(function* () {
			yield* lookupChat(chatId);
			yield* dispatchChatCommand(
				chatId,
				{
					_tag: "RenameChat",
					title,
					titleProvenance,
					updatedAt: yield* currentTimestamp,
				},
				commandId,
			);
			// Push the new title to any renderer subscribed via
			// `chat.streamChanges` so the sidebar updates without a refetch.
			const updated = yield* lookupChat(chatId);
			yield* broadcastChat(updated);
			return updated;
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

	const autoNameChat = (
		chatId: ChatId,
		sessionId: SessionId,
		turnId: string,
		commandId: string,
	): Effect.Effect<void> =>
		Effect.gen(function* () {
			if (yield* reactorEffects.isCompleted(commandId)) return;
			const qualified = yield* qualifyTurnForNaming(sql, sessionId, turnId);
			if (qualified === null) {
				yield* reactorEffects.complete(commandId);
				return;
			}
			let chat = yield* lookupChat(chatId).pipe(
				Effect.catch(() => Effect.succeed(null)),
			);
			if (chat === null) return;
			let session = yield* lookupSession(sessionId).pipe(
				Effect.catch(() => Effect.succeed(null)),
			);
			if (session === null) return;
			const initialRows = yield* sql<{ readonly id: string }>`
				SELECT id FROM sessions
				WHERE chat_id = ${chatId}
				ORDER BY created_at ASC
				LIMIT 1
			`.pipe(Effect.orDie);
			const isInitialSession = initialRows[0]?.id === sessionId;
			if (
				session.titleProvenance === "pending" ||
				(isInitialSession && chat.titleProvenance === "pending")
			) {
				const title = yield* titleGen.generate({
					folderId: chat.projectId,
					providerId: session.providerId,
					model: session.model,
					conversationText: qualified.conversationText,
					fallbackText: qualified.userText,
				});
				if (title.length > 0 && title !== "New chat") {
					session = yield* lookupSession(sessionId);
					if (session.titleProvenance === "pending") {
						yield* sessionDomain.dispatch({
							commandId: `${commandId}:session`,
							streamId: sessionId,
							command: {
								_tag: "SetTitle",
								title,
								titleProvenance: "automatic",
								updatedAt: yield* currentTimestamp,
							},
						});
					}
					chat = yield* lookupChat(chatId);
					if (isInitialSession && chat.titleProvenance === "pending") {
						yield* renameChatWithCommandId(
							chatId,
							title,
							`${commandId}:chat`,
							"automatic",
						);
					}
				}
			}

			const markComplete = reactorEffects.complete(commandId);
			if (!isInitialSession || chat.worktreeId === null) {
				yield* markComplete;
				return;
			}
			const worktreeId = chat.worktreeId;
			const wt = yield* worktrees.get(worktreeId);
			if (wt === null || wt.branchProvenance !== "pending") {
				yield* markComplete;
				return;
			}

			const settings = yield* configStore.getSettings();
			const username = yield* git
				.getUserName(chat.projectId)
				.pipe(Effect.catch(() => Effect.succeed("")));
			const branchFragment = yield* titleGen.generateBranch({
				folderId: chat.projectId,
				providerId: session.providerId,
				model: session.model,
				userText: qualified.userText,
			});
			const branch = formatBranchName(
				branchFragment,
				username,
				settings.branchNamingStyle,
				settings.branchNamingPrefix,
			);
			// Rename the git branch, then mirror it onto the worktree row so the
			// DB and git agree. updateBranch only runs if the rename succeeded.
			yield* worktrees
				.renameBranch(worktreeId, branch, "automatic")
				.pipe(Effect.catch(() => Effect.void));

			yield* markComplete;
		}).pipe(Effect.catchCause(() => Effect.void));

	return {
		renameChatWithCommandId,
		renameChat,
		markChatRead,
		autoNameChat,
	};
};
