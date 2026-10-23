import {
	AgentTurnId,
	type ChatId,
	type FolderId,
	SessionCheckpointError,
	SessionId,
	SessionNotFoundError,
	SessionStartError,
	type WorktreeId,
} from "@zuse/contracts";
import { makeJobWorker } from "@zuse/domain/agent-engine/job-worker";
import type { ChatCommand } from "@zuse/domain/chat/commands";
import type { SessionCommand } from "@zuse/domain/core/commands";
import { ChatDomain } from "@zuse/domain/engine/chat-domain";
import { SessionDomain } from "@zuse/domain/engine/session-domain";
import { SqlSessionQueries } from "@zuse/domain/queries/sql-session-queries";
import { GitService } from "@zuse/git/git-service";
import { WorktreeService } from "@zuse/git/worktree-service";
import {
	DateTime,
	Effect,
	FileSystem,
	Layer,
	Option,
	PubSub,
	Scope,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ApiActivityPublisher } from "../../api/activity-publisher.ts";
import { CheckpointService } from "../../checkpoint/service.ts";
import { ConfigStoreService } from "../../config-store/services/config-store-service.ts";
import { ModelCatalogService } from "../../model-catalog/services/model-catalog-service.ts";
import { NdjsonLogger } from "../../persistence/ndjson-logger.ts";
import { makeReactorEffectJournal } from "../../provider/reactor-effect-journal.ts";
import { ProviderService } from "../../provider/services/provider-service.ts";
import { TitleGenerator } from "../../provider/title-generator.ts";
import { PtyService } from "../../pty/services/pty-service.ts";
import { RepositorySettingsService } from "../../repository-settings/services/repository-settings-service.ts";
import { ReviewGuideService } from "../../review-guide/service.ts";
import { makeArchiveOperations } from "../core/archive-operations.ts";
import { makeAutoNameOperations } from "../core/auto-name-operations.ts";
import { makeChatOperations } from "../core/chat-operations.ts";
import { makeCheckpointRestore } from "../core/checkpoint-restore.ts";
import { makeContextHandoff } from "../core/context-handoff.ts";
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
	isCurrentGoalResidency,
	makeCurrentGoalPublisher,
} from "../core/current-goal-publisher.ts";
import { makeDelegationRuntime } from "../core/delegation-runtime.ts";
import { INGESTION_HEARTBEAT_MS } from "../core/ingestion-lease.ts";
import { sweepIngestionLeases } from "../core/ingestion-sweeper.ts";
import {
	type MessageOperations,
	makeMessageOperations,
} from "../core/message-operations.ts";
import { makeProviderJobExecutor } from "../core/provider-jobs.ts";
import { quiesceAndDetachProvider } from "../core/provider-quiescence.ts";
import { makeQuestionExpiry } from "../core/question-expiry.ts";
import {
	CheckpointFiles,
	makeSessionCheckpoints,
} from "../core/session-checkpoints.ts";
import { makeSessionOperations } from "../core/session-operations.ts";
import { makeSessionWaitOperations } from "../core/session-wait.ts";
import {
	hasRecoverableProviderSend,
	reconcileSessionRuntime,
	retireLegacyStartupRetries,
} from "../core/startup-recovery.ts";
import { makeTranscriptOperations } from "../core/transcript-operations.ts";
import { ConversationRuntime } from "../services/conversation-runtime.ts";
import type {
	ChatServiceShape,
	ConversationOperations,
	MessageServiceShape,
	SessionServiceShape,
	TranscriptServiceShape,
} from "../services/conversation-services.ts";
import { WorkspaceExecutionPolicy } from "../services/workspace-execution-policy.ts";
import { ChatServiceLive } from "./chat-service.ts";
import { MessageServiceLive } from "./message-service.ts";
import {
	QueueServiceLive,
	QueueTransactionServiceLive,
} from "./queue-service.ts";
import { SessionServiceLive } from "./session-service.ts";
import { TranscriptServiceLive } from "./transcript-service.ts";

const ConversationRuntimeLive = Layer.effect(
	ConversationRuntime,
	Effect.gen(function* () {
		const serviceScope = yield* Effect.scope;
		const executionPolicy = yield* WorkspaceExecutionPolicy;
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
				Effect.andThen(
					Effect.suspend(() => reactorRuntime.runSession(sessionId)),
				),
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
		const closeProvider = (sessionId: SessionId) =>
			Effect.gen(function* () {
				yield* appendSessionCommand(sessionId, {
					_tag: "RequestProviderStop",
					requestedAt: yield* currentTimestamp,
				});
				yield* reactorRuntime.runProviderStop(sessionId);
			});
		const ndjson = yield* NdjsonLogger;
		const worktrees = yield* WorktreeService;
		const fs = yield* FileSystem.FileSystem;
		const repositorySettings = yield* RepositorySettingsService;
		const ptys = yield* PtyService;
		const git = yield* GitService;
		const titleGen = yield* TitleGenerator;
		const configStore = yield* ConfigStoreService;
		const modelCatalog = yield* ModelCatalogService;

		const runtime = yield* Effect.context<never>();
		const apiActivity = yield* ApiActivityPublisher;
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
				isWorkspaceReady: () => executionPolicy.isReady,
				serviceScope,
				sql,
				state,
				sessionQueries,
				sessionDomain,
				currentTimestamp,
				ndjson,
				apiActivity,
				provider,
				dispatchSessionCommand: appendSessionCommand,
				runSessionReactors: (sessionId) =>
					Effect.suspend(() => reactorRuntime.runSession(sessionId)),
				flushQueueAfterIdle: (sessionId): Effect.Effect<void> =>
					Effect.suspend(() => queueRuntime.flushAfterIdle(sessionId)),
				shutdownQueueSession: (sessionId): Effect.Effect<void> =>
					Effect.suspend(() => queueRuntime.shutdown(sessionId)),
			});
		const {
			persistAttemptMessage,
			persistProviderMessage,
			setAttemptStatus,
			resolveActiveTurn,
			settleTurn,
			settleTurnFromReactor,
			ndjsonAppend,
			goalState,
			chatChangesHub,
			broadcastChat,
			currentChatRevision,
			lookupSession,
			agentsFor,
			persistMessage,
			submitTurn,
			setStatus,
			startSubscription,
			interruptProviderFiber,
			teardownSubscription,
		} = storeRuntime;

		const sessionOperations = makeSessionOperations({
			awaitWorkspaceReady: executionPolicy.awaitReady,
			interruptSession: (...args) =>
				Effect.suspend(() => interruptSession(...args)),
			addQueuedMessage: (...args) =>
				Effect.suspend(() => queueRuntime.service.addQueuedMessage(...args)),
			runQueuedMessageNext: (...args) =>
				Effect.suspend(() =>
					queueRuntime.service.runQueuedMessageNext(...args),
				),
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
			modelCatalog,
			worktrees,
			createChat: (input) => Effect.suspend(() => createChat(input)),
			getChat: (chatId) => Effect.suspend(() => lookupChat(chatId)),
			getSession: lookupSession,
			sendMessage: (...args) => Effect.suspend(() => sendMessage(...args)),
			waitSession: (...args) => Effect.suspend(() => waitSession(...args)),
			sendMessageAndWait: (...args) =>
				Effect.suspend(() => sendMessageAndWait(...args)),
			listMessages: (sessionId) =>
				Effect.suspend(() => listMessages(sessionId)),
			listChats: (...args) => Effect.suspend(() => listChats(...args)),
			setStatus,
			startSubscription,
			broadcastChat,
			persistMessage,
			persistProviderMessage,
			runSessionReactors: (sessionId) =>
				Effect.suspend(() => reactorRuntime.runSession(sessionId)),
			dispatchSessionCommand: appendSessionCommand,
			dispatchSessionCommandWithId: (sessionId, commandId, command) =>
				sessionDomain
					.dispatch({ commandId, streamId: sessionId, command })
					.pipe(Effect.orDie),
			ndjsonAppend,
			closeProvider,
			interruptProviderFiber,
			teardownSubscription,
		});
		const {
			listSessions,
			ensureForTurn,
			createSession,
			renameSession,
			setRuntimeMode,
			setPermissionMode,
			answerQuestion,
			cancelQuestion,
			respondToPlan,
			setWorktree,
			setModel,
			setProvider,
			releaseProvider,
			archiveSession,
			unarchiveSession,
			deleteSession,
			releaseInitialTurn,
		} = sessionOperations;

		const chatOperations = makeChatOperations({
			sql,
			currentTimestamp,
			createSession,
			broadcastChat,
			chatChangesHub,
			currentChatRevision,
			dispatchChatCommand,
		});
		const {
			lookupChat,
			listChats,
			getChat,
			getArchivePreview,
			streamChatChanges,
			runChatReconciliation,
			createChat,
		} = chatOperations;
		yield* Effect.forkIn(runChatReconciliation(), serviceScope);

		const transcriptOperations = makeTranscriptOperations({
			sql,
			sessionDomain,
			admitConstruction: (work) =>
				sessionDomain.admission.run(work).pipe(Effect.orDie),
			createChat,
			createSession,
			lookupChat,
			lookupSession,
			persistMessage,
		});
		yield* Effect.forkIn(
			Effect.forever(
				transcriptOperations
					.recoverForks()
					.pipe(Effect.andThen(Effect.sleep("2 seconds"))),
			),
			serviceScope,
		);
		const {
			continueExternalThread,
			importExternalMessages,
			forkSession,
			forkConstructions,
			retryFork,
			cancelFork,
			mergeBack,
			contextLinks,
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
		const checkpoints = makeSessionCheckpoints(
			sql,
			git,
			yield* CheckpointFiles,
			provider.captureHistoryCheckpoint,
		);
		const executeProviderJob = makeProviderJobExecutor({
			awaitWorkspaceReady: executionPolicy.awaitReady,
			captureBaseline: (session, turnId, attemptId) =>
				checkpoints.capture(session, turnId, attemptId, "baseline"),
			finalizeCheckpoint: (sessionId, turnId, attemptId, outcome) =>
				Effect.gen(function* () {
					const active = yield* sessionDomain
						.activeAttempt(sessionId)
						.pipe(Effect.orDie);
					if (active?.turnId !== turnId || active.attemptId !== attemptId)
						return;
					const session = yield* lookupSession(sessionId).pipe(Effect.orDie);
					if (outcome !== "completed" && provider.quiesce !== undefined)
						yield* quiesceAndDetachProvider(
							sessionDomain,
							provider,
							sessionId,
						).pipe(
							Effect.mapError(
								() =>
									new SessionCheckpointError({
										message:
											"Provider processes must stop before the interrupted turn can be checkpointed.",
									}),
							),
						);
					yield* checkpoints.capture(
						session,
						turnId,
						attemptId,
						"final",
						outcome,
					);
					yield* storeRuntime.completeFinalization(sessionId, turnId, outcome, {
						turnId,
						attemptId,
					});
				}),
			prepareContext: makeContextHandoff(sql).prepare,
			prepareFallbackContext: makeContextHandoff(sql).prepareFallback,
			delivery: reactorEffects,
			authorizeQueuedTurn: executionPolicy.authorize,
			getSession: lookupSession,
			ensureForTurn,
			persistMessage: persistAttemptMessage,
			ndjsonAppend,
			setStatus: setAttemptStatus,
			getProviderStartJson: (sessionId) =>
				sql<{ readonly provider_start_json: string | null }>`
					SELECT json_extract(payload_json, '$.providerStartJson') AS provider_start_json
					FROM events
					WHERE stream_kind = 'session'
						AND stream_id = ${sessionId}
						AND type IN ('SessionCreated', 'SessionProviderSet')
					ORDER BY stream_version DESC
					LIMIT 1
				`.pipe(
					Effect.map((rows) => rows[0]?.provider_start_json ?? null),
					Effect.orDie,
				),
			settleTurn: settleTurnFromReactor,
			rememberActiveTurn: (sessionId, turnId) =>
				state.rememberActiveTurn(sessionId, turnId),
			provider,
			sessionDomain,
		});
		const jobWorker = yield* makeJobWorker({
			excludedKinds: () =>
				executionPolicy.isReady
					? []
					: [
							"provider.turn.send",
							"provider.turn.recover",
							"provider.successor.start",
						],
			ledger: sessionDomain.jobs,
			execute: executeProviderJob,
			workerId: `server:${process.pid}`,
			onFailure: (failure) =>
				Effect.logWarning(
					`[ConversationServices] job ${failure.job.id} (${failure.job.request._tag}) ${failure.outcome}: ${failure.failure.message}`,
				),
		});

		const handleAutoName = (
			input: Parameters<
				Parameters<typeof makeConversationReactorRuntime>[0]["autoName"]
			>[0],
		) =>
			Effect.gen(function* () {
				const sessionId = SessionId.make(input.streamId);
				const session = yield* lookupSession(sessionId).pipe(Effect.orDie);
				yield* autoNameChat(
					session.chatId,
					sessionId,
					input.command.turnId,
					input.commandId,
				);
			});

		// Only recent turns refresh a guide: catching up after a restart must
		// not start a run for every workspace that ever finished a turn.
		const REVIEW_GUIDE_REFRESH_WINDOW_MS = 10 * 60_000;
		const reviewGuides = yield* Effect.serviceOption(ReviewGuideService);
		const handleReviewGuide = (
			input: Parameters<
				Parameters<typeof makeConversationReactorRuntime>[0]["reviewGuide"]
			>[0],
		) =>
			Effect.gen(function* () {
				if (Option.isNone(reviewGuides)) return;
				const settledAt = input.command.settledAt;
				if (
					settledAt === null ||
					Date.now() - settledAt > REVIEW_GUIDE_REFRESH_WINDOW_MS
				)
					return;
				const sessionId = SessionId.make(input.streamId);
				const session = yield* lookupSession(sessionId).pipe(
					Effect.orElseSucceed(() => null),
				);
				if (session === null || session.parentSessionId != null) return;
				yield* reviewGuides.value.requestRefresh(
					{ folderId: session.projectId, worktreeId: session.worktreeId },
					"turn",
					sessionId,
				);
			});

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
			getArchiveStatus,
			listArchiveJobs,
			getChatDirectoryStatus,
			unarchiveChat,
			deleteChatWithReactor,
			handleChatArchive,
			handleChatDelete,
		} = archiveOperations;
		const reactorRuntime: ConversationReactorRuntime =
			yield* makeConversationReactorRuntime(
				{
					autoName: handleAutoName,
					reviewGuide: handleReviewGuide,
					chatArchive: handleChatArchive,
					chatDelete: handleChatDelete,
				},
				jobWorker,
				serviceScope,
			);
		const archiveChat: ConversationOperations["archiveChat"] = (
			chatId,
			force,
		) =>
			archiveChatWithReactor(
				chatId,
				force ?? false,
				reactorRuntime.runChatArchive,
			);
		const deleteChat: ConversationOperations["deleteChat"] = (chatId) =>
			deleteChatWithReactor(chatId, reactorRuntime.runChatDelete);
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
			publishCurrent: makeCurrentGoalPublisher(sql, goalState.publish),
			isCurrent: (sessionId, residency) =>
				isCurrentGoalResidency(sql, sessionId, residency),
			lookupSession,
			admission: sessionDomain.admission,
			lastGoalObjective: (sessionId) =>
				sql<{
					objective: string;
				}>`SELECT json_extract(content_json, '$.text') AS objective FROM messages WHERE session_id=${sessionId} AND json_extract(content_json, '$.goal')=1 AND role='user' ORDER BY sequence DESC LIMIT 1`.pipe(
					Effect.map((rows) => rows[0]?.objective ?? null),
					Effect.orDie,
				),
			hasActiveTurn: (sessionId) =>
				sessionDomain.activeAttempt(sessionId).pipe(
					Effect.map((value) => value !== null),
					Effect.orDie,
				),
			submitGoal: (session, goal, displayObjective) =>
				Effect.gen(function* () {
					const text = displayObjective;
					yield* submitTurn(
						session.id,
						AgentTurnId.make(crypto.randomUUID()),
						{ _tag: "user", text, goal: true },
						JSON.stringify({
							text,
							attachments: [],
							fileRefs: [],
							skillRefs: [],
							annotations: [],
							goal,
						}),
					);
					yield* reactorRuntime.runSession(session.id);
				}).pipe(
					Effect.catchCause(() =>
						Effect.fail(
							new SessionStartError({
								providerId: session.providerId,
								reason:
									"Goal could not be admitted. The session may already be running or shutting down.",
							}),
						),
					),
				),
		});
		const { getGoal, setGoal, clearGoal, streamGoal } = goalOperations;

		const messageOperations: MessageOperations = yield* makeMessageOperations({
			sql,
			fs,
			goalState,
			lookupSession,
			ensureForTurn,
			setStatus,
			persistMessage,
			submitTurn,
			ndjsonAppend,
			setGoal,
			dispatchSessionCommand: appendSessionCommand,
			dispatchSessionCommandWithId: (sessionId, commandId, command) =>
				sessionDomain
					.dispatch({ commandId, streamId: sessionId, command })
					.pipe(Effect.orDie),
			dispatchSessionCommandWithIdTransactionally: (
				sessionId,
				commandId,
				command,
				onCommitted,
			) =>
				sessionDomain
					.dispatchTransactionally(
						{ commandId, streamId: sessionId, command },
						onCommitted,
					)
					.pipe(Effect.orDie),
			settleTurn,
			resolveActiveTurn,
			runSessionReactors: (sessionId) =>
				Effect.suspend(() => reactorRuntime.runSession(sessionId)),
			serviceScope,
			hasPendingProviderTurn: (sessionId) =>
				sessionDomain.activeAttempt(sessionId).pipe(
					Effect.orDie,
					Effect.flatMap((attempt) =>
						attempt === null
							? Effect.succeed(false)
							: hasRecoverableProviderSend(sql, sessionId, attempt),
					),
				),
			closeProvider,
			hasProvider: (sessionId) => provider.hasSession(sessionId),
			interruptProviderFiber,
		});
		const {
			resumeSession,
			sendMessage,
			sendMessageWithInput,
			interruptSession,
			queueRuntime,
		} = messageOperations;

		const { waitSession, sendMessageAndWait } = makeSessionWaitOperations({
			sql,
			domain: sessionDomain,
			scope: serviceScope,
			send: sendMessageWithInput,
		});
		const getSession = lookupSession;

		const sessionService = {
			listSessions,
			getSession,
			createSession,
			renameSession,
			setModel,
			setProvider,
			releaseProvider,
			setRuntimeMode,
			setPermissionMode,
			answerQuestion,
			cancelQuestion,
			respondToPlan,
			setWorktree,
			archiveSession,
			unarchiveSession,
			deleteSession,
			releaseInitialTurn,
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
			getArchiveStatus,
			listArchiveJobs,
			getChatDirectoryStatus,
			unarchiveChat,
			deleteChat,
		} satisfies ChatServiceShape;
		const transcriptService = {
			continueExternalThread,
			importExternalMessages,
			forkSession,
			forkConstructions,
			retryFork,
			cancelFork,
			mergeBack,
			contextLinks,
			exportTranscript,
			latestPlan,
		} satisfies TranscriptServiceShape;
		const messageService = {
			listMessages,
			sendMessage,
			sendMessageWithInput,
			interruptSession,
			waitSession,
			sendMessageAndWait,
		} satisfies MessageServiceShape;
		const queueService = queueRuntime.service;

		const jobWakeups = yield* PubSub.subscribe(sessionDomain.jobWakeups).pipe(
			Effect.provideService(Scope.Scope, serviceScope),
		);
		const jobCancellations = yield* PubSub.subscribe(
			sessionDomain.jobCancellations,
		).pipe(Effect.provideService(Scope.Scope, serviceScope));
		yield* Effect.forkIn(
			Effect.forever(
				PubSub.take(jobWakeups).pipe(Effect.andThen(jobWorker.notify)),
			),
			serviceScope,
		);
		yield* Effect.forkIn(
			Effect.forever(
				PubSub.take(jobCancellations).pipe(Effect.flatMap(jobWorker.cancel)),
			),
			serviceScope,
		);

		yield* retireLegacyStartupRetries(sql);
		yield* sessionDomain.jobs.reconcileAfterProcessLoss.pipe(Effect.orDie);
		const checkpointService = yield* makeCheckpointRestore({
			sql,
			activeTurnCount: sessionQueries.activeTurnCount,
			domain: sessionDomain,
			getSession: lookupSession,
			provider,
			teardown: storeRuntime.teardownSubscription,
			retryFinalization: (sessionId) => reactorRuntime.runSession(sessionId),
		});
		yield* reconcileSessionRuntime(sql, sessionDomain);
		yield* checkpointService.recover;
		yield* sessionOperations.recoverPlanResponses;
		yield* sessionOperations.reconcilePlanInputs;
		const delegatedWork = makeDelegationRuntime(sql, sessionDomain);
		yield* delegatedWork.sweep;
		const expireQuestions = makeQuestionExpiry(sql, sessionDomain, provider);
		yield* expireQuestions;
		yield* Effect.forkIn(
			Effect.forever(
				Effect.sleep("1 second").pipe(
					Effect.andThen(expireQuestions),
					Effect.andThen(sessionOperations.reconcilePlanInputs),
					Effect.andThen(delegatedWork.sweep),
					Effect.catchCause(() =>
						Effect.logError("[ConversationServices] question expiry failed"),
					),
				),
			),
			serviceScope,
		);
		yield* Effect.forkIn(
			Effect.forever(
				Effect.sleep(INGESTION_HEARTBEAT_MS).pipe(
					Effect.andThen(
						Effect.suspend(() => sweepIngestionLeases(sql, sessionDomain)),
					),
					Effect.catchCause(() =>
						Effect.logError(
							"[ConversationServices] ingestion lease sweep failed",
						),
					),
				),
			),
			serviceScope,
		);
		yield* jobWorker.start.pipe(
			Effect.provideService(Scope.Scope, serviceScope),
		);
		yield* Effect.forkIn(
			executionPolicy.awaitReady.pipe(Effect.andThen(jobWorker.notify)),
			serviceScope,
		);

		yield* Effect.forkIn(
			Effect.all(
				[
					executionPolicy.awaitReady.pipe(
						Effect.andThen(reactorRuntime.catchUpAll),
					),
					queueRuntime.reconcileReadyQueues,
				],
				{ concurrency: "unbounded" },
			).pipe(
				Effect.catchCause((cause) =>
					Effect.logError(
						`[ConversationServices] background recovery failed: ${String(cause)}`,
					),
				),
			),
			serviceScope,
		);
		return ConversationRuntime.of({
			checkpoints: checkpointService,
			session: sessionService,
			chat: chatService,
			transcript: transcriptService,
			message: messageService,
			queue: queueService,
			queueTransaction: queueRuntime.transactionService,
		});
	}),
);

/** Public compatibility aggregate; each tag is implemented by its own layer. */
export const ConversationServicesLive = Layer.mergeAll(
	Layer.effect(
		CheckpointService,
		Effect.map(ConversationRuntime, (runtime) => runtime.checkpoints),
	),
	SessionServiceLive,
	ChatServiceLive,
	TranscriptServiceLive,
	MessageServiceLive,
	QueueServiceLive,
	QueueTransactionServiceLive,
).pipe(Layer.provide(ConversationRuntimeLive));
