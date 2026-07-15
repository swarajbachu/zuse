import {
	type ChatId,
	type FolderId,
	type ProviderId,
	type SessionId,
	SessionNotFoundError,
	type WorktreeId,
} from "@zuse/contracts";
import type { ChatCommand } from "@zuse/domain/chat/commands";
import type { SessionCommand } from "@zuse/domain/core/commands";
import { ChatDomain } from "@zuse/domain/engine/chat-domain";
import { SessionDomain } from "@zuse/domain/engine/session-domain";
import { SqlSessionQueries } from "@zuse/domain/queries/sql-session-queries";
import { GitService } from "@zuse/git/git-service";
import { WorktreeService } from "@zuse/git/worktree-service";
import { DateTime, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ConfigStoreService } from "../../config-store/services/config-store-service.ts";
import { NdjsonLogger } from "../../persistence/ndjson-logger.ts";
import { makeReactorEffectJournal } from "../../provider/reactor-effect-journal.ts";
import { ProviderService } from "../../provider/services/provider-service.ts";
import { TitleGenerator } from "../../provider/title-generator.ts";
import { PtyService } from "../../pty/services/pty-service.ts";
import { RelayActivityPublisher } from "../../relay/activity-publisher.ts";
import { RepositorySettingsService } from "../../repository-settings/services/repository-settings-service.ts";
import { makeArchiveOperations } from "../core/archive-operations.ts";
import { makeAutoNameOperations } from "../core/auto-name-operations.ts";
import { makeChatOperations } from "../core/chat-operations.ts";
import { makeConversationGoalOperations } from "../core/conversation-goal-operations.ts";
import {
	type ConversationReactorRuntime,
	makeConversationReactorRuntime,
} from "../core/conversation-reactors.ts";
import { messageFromRecord } from "../core/conversation-records.ts";
import { ConversationState } from "../core/conversation-state.ts";
import {
	type ConversationStoreRuntime,
	makeConversationStoreRuntime,
} from "../core/conversation-store-runtime.ts";
import {
	type MessageOperations,
	makeMessageOperations,
} from "../core/message-operations.ts";
import { makeProviderReactorHandlers } from "../core/provider-reactor-handlers.ts";
import { makeSessionOperations } from "../core/session-operations.ts";
import { makeTranscriptOperations } from "../core/transcript-operations.ts";
import { ConversationRuntime } from "../services/conversation-runtime.ts";
import type {
	ChatServiceShape,
	ConversationOperations,
	MessageServiceShape,
	SessionServiceShape,
	TranscriptServiceShape,
} from "../services/conversation-services.ts";
import { ChatServiceLive } from "./chat-service.ts";
import { MessageServiceLive } from "./message-service.ts";
import { QueueServiceLive } from "./queue-service.ts";
import { SessionServiceLive } from "./session-service.ts";
import { TranscriptServiceLive } from "./transcript-service.ts";

const ConversationRuntimeLive = Layer.effect(
	ConversationRuntime,
	Effect.gen(function* () {
		const serviceScope = yield* Effect.scope;
		const sql = yield* SqlClient.SqlClient;
		const state = yield* ConversationState;
		const sessionQueries = yield* SqlSessionQueries;
		const sessionDomain = yield* SessionDomain;
		const chatDomain = yield* ChatDomain;
		const reactorEffects = makeReactorEffectJournal(sql);
		const currentTimestamp = DateTime.nowAsDate.pipe(
			Effect.map((now) => now.getTime()),
		);
		const appendSessionCommand = (
			sessionId: SessionId,
			command: SessionCommand,
		): Effect.Effect<void> =>
			sessionDomain
				.dispatch({
					commandId: crypto.randomUUID(),
					streamId: sessionId,
					command,
				})
				.pipe(Effect.asVoid, Effect.orDie);
		function dispatchSessionCommand(
			sessionId: SessionId,
			command: SessionCommand,
		): Effect.Effect<void> {
			return appendSessionCommand(sessionId, command).pipe(
				Effect.andThen(Effect.suspend(() => reactorRuntime.runSession)),
			);
		}
		const dispatchChatCommand = (
			chatId: ChatId,
			command: ChatCommand,
			commandId: string = crypto.randomUUID(),
		): Effect.Effect<void> =>
			chatDomain
				.dispatch({
					commandId,
					streamId: chatId,
					command,
				})
				.pipe(Effect.asVoid, Effect.orDie);
		const provider = yield* ProviderService;
		const attachProvider = (sessionId: SessionId, providerId: ProviderId) =>
			Effect.gen(function* () {
				yield* appendSessionCommand(sessionId, {
					_tag: "AttachProvider",
					providerId,
					attachedAt: yield* currentTimestamp,
				});
			});
		const closeProvider = (sessionId: SessionId) =>
			Effect.gen(function* () {
				yield* appendSessionCommand(sessionId, {
					_tag: "RequestProviderStop",
					requestedAt: yield* currentTimestamp,
				});
				yield* reactorRuntime.runProviderStop;
			});
		const ndjson = yield* NdjsonLogger;
		const worktrees = yield* WorktreeService;
		const repositorySettings = yield* RepositorySettingsService;
		const ptys = yield* PtyService;
		const git = yield* GitService;
		const titleGen = yield* TitleGenerator;
		const configStore = yield* ConfigStoreService;
		// Captured once so the control-plane orchestration tools — which the
		// Claude SDK invokes as plain async functions — can bridge back into
		// these Effect methods via `Runtime.runPromise`. Same shape as the
		// browser-bridge tool binding in ProviderService.
		const runtime = yield* Effect.context<never>();
		const relayActivity = yield* RelayActivityPublisher;

		const chatColumns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(chats)
    `.pipe(Effect.orDie);
		const hasChatColumn = (name: string): boolean =>
			chatColumns.some((column) => column.name === name);
		if (!hasChatColumn("archived_worktree_json")) {
			yield* sql`
        ALTER TABLE chats
          ADD COLUMN archived_worktree_json TEXT
      `.pipe(Effect.orDie);
		}

		// Worktree deletion can null the sessions read-model FK without emitting
		// a session-domain event. Reconcile live members from their owning chat at
		// startup so records affected by an interrupted or older restore heal on
		// the next launch instead of silently starting providers in main.
		yield* sql`
      UPDATE sessions
      SET worktree_id = (
        SELECT c.worktree_id
        FROM chats c
        INNER JOIN worktrees w ON w.id = c.worktree_id
        WHERE c.id = sessions.chat_id
          AND c.archived_at IS NULL
      )
      WHERE archived_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM chats c
          INNER JOIN worktrees w ON w.id = c.worktree_id
          WHERE c.id = sessions.chat_id
            AND c.archived_at IS NULL
            AND sessions.worktree_id IS NOT c.worktree_id
        )
    `.pipe(Effect.orDie);

		/**
		 * Resolve the cwd a session should run in. NULL `worktreeId` falls
		 * through to the project's main checkout (handled by `provider.start`
		 * when `cwdOverride` is omitted). Missing rows also fall through.
		 */
		const cwdForWorktree = (
			worktreeId: WorktreeId | null,
		): Effect.Effect<string | undefined> =>
			worktreeId === null
				? Effect.succeed(undefined)
				: Effect.map(worktrees.get(worktreeId), (wt) => wt?.path ?? undefined);

		const projectPath = (projectId: FolderId): Effect.Effect<string | null> =>
			Effect.gen(function* () {
				const rows = yield* sql<{ readonly path: string }>`
          SELECT path FROM projects WHERE id = ${projectId} LIMIT 1
        `.pipe(Effect.orDie);
				return rows[0]?.path ?? null;
			});

		const storeRuntime: ConversationStoreRuntime =
			yield* makeConversationStoreRuntime({
				serviceScope,
				sql,
				state,
				sessionQueries,
				sessionDomain,
				currentTimestamp,
				ndjson,
				relayActivity,
				provider,
				dispatchSessionCommand,
				runSessionReactors: Effect.suspend(() => reactorRuntime.runSession),
				flushQueueAfterIdle: (sessionId): Effect.Effect<void> =>
					Effect.suspend(() => queueRuntime.flushAfterIdle(sessionId)),
				shutdownQueueSession: (sessionId): Effect.Effect<void> =>
					Effect.suspend(() => queueRuntime.shutdown(sessionId)),
			});
		const {
			beginTurn,
			settleActiveTurn,
			ndjsonAppend,
			goalState,
			chatChangesHub,
			broadcastChat,
			lookupSession,
			agentsFor,
			persistMessage,
			setStatus,
			startSubscription,
			interruptProviderFiber,
			teardownSubscription,
		} = storeRuntime;

		const sessionOperations = makeSessionOperations({
			serviceScope,
			sql,
			state,
			sessionQueries,
			sessionDomain,
			provider,
			currentTimestamp,
			agentsFor,
			cwdForWorktree,
			runtime,
			configStore,
			worktrees,
			createChat: (input) => Effect.suspend(() => createChat(input)),
			getChat: (chatId) => Effect.suspend(() => lookupChat(chatId)),
			getSession: lookupSession,
			sendMessage: (...args) => Effect.suspend(() => sendMessage(...args)),
			listMessages: (sessionId) =>
				Effect.suspend(() => listMessages(sessionId)),
			listChats: (...args) => Effect.suspend(() => listChats(...args)),
			attachProvider,
			setStatus,
			startSubscription,
			broadcastChat,
			beginTurn,
			persistMessage,
			runProviderStart: Effect.suspend(() => reactorRuntime.runProviderStart),
			dispatchSessionCommand,
			ndjsonAppend,
			closeProvider,
			interruptProviderFiber,
			teardownSubscription,
		});
		const {
			listSessions,
			openProviderSession,
			createSession,
			renameSession,
			setRuntimeMode,
			setPermissionMode,
			answerQuestion,
			setWorktree,
			setModel,
			setProvider,
			archiveSession,
			unarchiveSession,
			deleteSession,
		} = sessionOperations;

		// -------------------------------------------------------------------------
		// Chats — sidebar containers. Each chat hosts ≥ 1 session as a tab.
		// -------------------------------------------------------------------------

		const chatOperations = makeChatOperations({
			sql,
			currentTimestamp,
			createSession,
			broadcastChat,
			chatChangesHub,
			dispatchChatCommand,
		});
		const {
			lookupChat,
			listChats,
			getChat,
			getArchivePreview,
			streamChatChanges,
			createChat,
		} = chatOperations;

		const transcriptOperations = makeTranscriptOperations({
			sql,
			createChat,
			createSession,
			lookupChat,
			lookupSession,
			persistMessage,
		});
		const {
			continueExternalThread,
			importExternalMessages,
			forkSession,
			exportTranscript,
			latestPlan,
		} = transcriptOperations;
		const autoNameOperations = makeAutoNameOperations({
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
		});
		const { renameChat, markChatRead, autoNameChat } = autoNameOperations;
		const { handleProviderStart, handleProviderStop, handleAutoName } =
			makeProviderReactorHandlers({
				reactorEffects,
				getSession: lookupSession,
				openProviderSession,
				persistMessage,
				ndjsonAppend,
				setStatus,
				provider,
				sessionDomain,
				autoNameChat,
			});

		/**
		 * Worktrees are immutable past the first user message in any of the
		 * chat's sessions. Mirrors `session.setWorktree`'s pre-message check
		 * but lifted to the chat scope.
		 */
		const archiveOperations = yield* makeArchiveOperations({
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
		});
		const {
			setChatWorktree,
			setChatActiveSession,
			archiveChatWithReactor,
			unarchiveChat,
			deleteChatWithReactor,
			handleChatArchive,
			handleChatDelete,
		} = archiveOperations;
		const reactorRuntime: ConversationReactorRuntime =
			yield* makeConversationReactorRuntime({
				providerStart: handleProviderStart,
				providerStop: handleProviderStop,
				autoName: handleAutoName,
				chatArchive: handleChatArchive,
				chatDelete: handleChatDelete,
			});
		const archiveChat: ConversationOperations["archiveChat"] = (chatId) =>
			archiveChatWithReactor(chatId, reactorRuntime.runChatArchive);
		const deleteChat: ConversationOperations["deleteChat"] = (chatId) =>
			deleteChatWithReactor(chatId, reactorRuntime.runChatDelete);
		yield* reactorRuntime.catchUpAll;

		const listMessages: ConversationOperations["listMessages"] = (sessionId) =>
			sessionQueries.messages(sessionId).pipe(
				Effect.map((records) => records.map(messageFromRecord)),
				Effect.catch((error) =>
					error._tag === "SessionQueryNotFound"
						? Effect.fail(new SessionNotFoundError({ sessionId }))
						: Effect.die(error),
				),
			);

		const goalOperations = makeConversationGoalOperations({
			provider,
			state: goalState,
			lookupSession,
			openProviderSession,
		});
		const { getGoal, setGoal, clearGoal, streamGoal } = goalOperations;

		const messageOperations: MessageOperations = yield* makeMessageOperations({
			sql,
			provider,
			goalState,
			lookupSession,
			openProviderSession,
			setStatus,
			persistMessage,
			ndjsonAppend,
			lookupChat,
			setGoal,
			dispatchSessionCommand,
			beginTurn,
			settleActiveTurn,
			serviceScope,
			recoverStatus: (sessionId, status) =>
				dispatchSessionCommand(sessionId, {
					_tag: "SetStatus",
					status,
					updatedAt: Date.now(),
				}),
			closeProvider,
			interruptProviderFiber,
			renameSession,
			renameChat,
		});
		const { resumeSession, sendMessage, interruptSession, queueRuntime } =
			messageOperations;

		const getSession: ConversationOperations["getSession"] = (sessionId) =>
			lookupSession(sessionId);

		const sessionService = {
			listSessions,
			getSession,
			createSession,
			renameSession,
			setModel,
			setProvider,
			setRuntimeMode,
			setPermissionMode,
			answerQuestion,
			setWorktree,
			archiveSession,
			unarchiveSession,
			deleteSession,
			resumeSession,
			getGoal,
			setGoal,
			clearGoal,
			streamGoal,
		} satisfies SessionServiceShape;
		const chatService = {
			listChats,
			getChat,
			getArchivePreview,
			createChat,
			renameChat,
			markChatRead,
			streamChatChanges,
			setChatWorktree,
			setChatActiveSession,
			archiveChat,
			unarchiveChat,
			deleteChat,
		} satisfies ChatServiceShape;
		const transcriptService = {
			continueExternalThread,
			importExternalMessages,
			forkSession,
			exportTranscript,
			latestPlan,
		} satisfies TranscriptServiceShape;
		const messageService = {
			listMessages,
			sendMessage,
			interruptSession,
		} satisfies MessageServiceShape;
		const queueService = queueRuntime.service;
		return ConversationRuntime.of({
			session: sessionService,
			chat: chatService,
			transcript: transcriptService,
			message: messageService,
			queue: queueService,
		});
	}),
);

/** Public compatibility aggregate; each tag is implemented by its own layer. */
export const ConversationServicesLive = Layer.mergeAll(
	SessionServiceLive,
	ChatServiceLive,
	TranscriptServiceLive,
	MessageServiceLive,
	QueueServiceLive,
).pipe(Layer.provide(ConversationRuntimeLive));
