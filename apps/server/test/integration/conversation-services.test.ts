import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import type { OrchestrationSessionTools } from "@zuse/agents/drivers/orchestration-tools";
import { validateUserQuestionAnswers } from "@zuse/agents/kernel/user-question-answer";
import type {
	AgentEvent,
	AgentSessionId,
	AutonomyLevel,
	FolderId,
	StartSessionInput,
	UserQuestionAnswer,
	WorktreeId,
} from "@zuse/contracts";
import {
	AgentItemId,
	AgentSessionNotFoundError,
	AgentSessionStartError,
	AgentTurnId,
	BUNDLED_MODEL_CATALOG,
	ChatId,
	ComposerInput,
	defaultModelFor,
	MessageId,
	PtyCatalog,
	RepositorySettings,
	SessionId,
	ThreadGoal,
	Worktree,
	WorktreeCheckpointError,
	WorktreeRestoreError,
} from "@zuse/contracts";
import type { SessionEvent } from "@zuse/domain/core/events";
import { ChatDomain } from "@zuse/domain/engine/chat-domain";
import type { DispatchInput, StoredEvent } from "@zuse/domain/engine/dispatch";
import {
	SessionDomain,
	type SessionDomainApi,
} from "@zuse/domain/engine/session-domain";
import {
	makeSqlSessionQueries,
	SqlSessionQueries,
} from "@zuse/domain/queries/sql-session-queries";
import { GitService } from "@zuse/git/git-service";
import { WorktreeService } from "@zuse/git/worktree-service";

import { layer as sqliteLayer } from "@zuse/sqlite";
import {
	Context,
	Deferred,
	Effect,
	Fiber,
	Layer,
	ManagedRuntime,
	Schedule,
	Stream,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiActivityPublisher } from "../../src/api/activity-publisher.ts";
import { startCloudWorkspaceLaunchIntent } from "../../src/api/cloud-workspace-runtime.ts";
import { ConfigStoreService } from "../../src/config-store/services/config-store-service.ts";
import { ConversationState } from "../../src/conversation/core/conversation-state.ts";
import { CheckpointFiles } from "../../src/conversation/core/session-checkpoints.ts";
import { ConversationServicesLive } from "../../src/conversation/layers/conversation-services.ts";
import {
	ChatService,
	type ConversationOperations,
	MessageService,
	QueueService,
	SessionService,
	TranscriptService,
} from "../../src/conversation/services/conversation-services.ts";
import { WorkspaceExecutionPolicy } from "../../src/conversation/services/workspace-execution-policy.ts";
import { Migration0001Initial } from "../../src/persistence/migrations/0001_initial.ts";
import { Migration0002Permissions } from "../../src/persistence/migrations/0002_permissions.ts";
import { Migration0003ResumeAndExport } from "../../src/persistence/migrations/0003_resume_and_export.ts";
import { Migration0004PermissionScope } from "../../src/persistence/migrations/0004_permission_scope.ts";
import { Migration0005RuntimeMode } from "../../src/persistence/migrations/0005_runtime_mode.ts";
import { Migration0006Attachments } from "../../src/persistence/migrations/0006_attachments.ts";
import { Migration0007Subagents } from "../../src/persistence/migrations/0007_subagents.ts";
import { Migration0008WorktreesAndRepoSettings } from "../../src/persistence/migrations/0008_worktrees_and_repo_settings.ts";
import { Migration0009PermissionModeAndToolSearch } from "../../src/persistence/migrations/0009_permission_mode_and_tool_search.ts";
import { Migration0010NestedSessions } from "../../src/persistence/migrations/0010_nested_sessions.ts";
import { Migration0011ChatsTable } from "../../src/persistence/migrations/0011_chats_table.ts";
import { Migration0012ChatIdNotNull } from "../../src/persistence/migrations/0012_chat_id_not_null.ts";
import { Migration0013ArchiveCleanup } from "../../src/persistence/migrations/0013_archive_cleanup.ts";
import { Migration0014ScriptsAndSetup } from "../../src/persistence/migrations/0014_scripts_and_setup.ts";
import { Migration0015QueuedMessages } from "../../src/persistence/migrations/0015_queued_messages.ts";
import { Migration0016QueuedMessagesQueueOrderRepair } from "../../src/persistence/migrations/0016_queued_messages_queue_order_repair.ts";
import { Migration0017ChatReadState } from "../../src/persistence/migrations/0017_chat_read_state.ts";
import { Migration0018PokemonWorktrees } from "../../src/persistence/migrations/0018_pokemon_worktrees.ts";
import { Migration0019QueuePaused } from "../../src/persistence/migrations/0019_queue_paused.ts";
import { Migration0020Events } from "../../src/persistence/migrations/0020_events.ts";
import { Migration0023ChatLineage } from "../../src/persistence/migrations/0023_chat_lineage.ts";
import { Migration0029ChatLineageRepair } from "../../src/persistence/migrations/0029_chat_lineage_repair.ts";
import { Migration0030CqrsEngine } from "../../src/persistence/migrations/0030_cqrs_engine.ts";
import { Migration0031BackfillRuns } from "../../src/persistence/migrations/0031_backfill_runs.ts";
import { Migration0032ReactorEffectReceipts } from "../../src/persistence/migrations/0032_reactor_effect_receipts.ts";
import { Migration0033ReactorEffectSteps } from "../../src/persistence/migrations/0033_reactor_effect_steps.ts";
import { Migration0034ToolEventLookup } from "../../src/persistence/migrations/0034_tool_event_lookup.ts";
import { Migration0037ProviderEventCursor } from "../../src/persistence/migrations/0037_provider_event_cursor.ts";
import { Migration0038QueuedMessageReady } from "../../src/persistence/migrations/0038_queued_message_ready.ts";
import { Migration0041ChatArchiveJobs } from "../../src/persistence/migrations/0041_chat_archive_jobs.ts";
import { Migration0043NameProvenance } from "../../src/persistence/migrations/0043_name_provenance.ts";
import { Migration0045ChatCatalogRevision } from "../../src/persistence/migrations/0045_chat_catalog_revision.ts";
import { Migration0046SessionTimelineHead } from "../../src/persistence/migrations/0046_session_timeline_head.ts";
import { Migration0047MessageCheckpoints } from "../../src/persistence/migrations/0047_message_checkpoints.ts";
import { Migration0053CloudCommandReceipts } from "../../src/persistence/migrations/0053_cloud_command_receipts.ts";
import { Migration0054ProviderEffectOutcomes } from "../../src/persistence/migrations/0054_provider_effect_outcomes.ts";
import { Migration0058QuestionAnswerDeliveries } from "../../src/persistence/migrations/0058_question_answer_deliveries.ts";
import { Migration0060ChatUserMessageTime } from "../../src/persistence/migrations/0060_chat_user_message_time.ts";
import { Migration0063Jobs } from "../../src/persistence/migrations/0063_jobs.ts";
import { Migration0064SessionGraph } from "../../src/persistence/migrations/0064_session_graph.ts";
import { Migration0067ProviderReservations } from "../../src/persistence/migrations/0067_provider_reservations.ts";
import { Migration0068AttemptHistory } from "../../src/persistence/migrations/0068_attempt_history.ts";
import { Migration0069AttemptProviderTurn } from "../../src/persistence/migrations/0069_attempt_provider_turn.ts";
import { Migration0070IngestionLeases } from "../../src/persistence/migrations/0070_ingestion_leases.ts";
import { Migration0071SessionInputs } from "../../src/persistence/migrations/0071_session_inputs.ts";
import { Migration0072InputOwnership } from "../../src/persistence/migrations/0072_input_ownership.ts";
import { Migration0073QuestionExpiry } from "../../src/persistence/migrations/0073_question_expiry.ts";
import { Migration0074PlanDeliveries } from "../../src/persistence/migrations/0074_plan_deliveries.ts";
import { Migration0075ContextHandoffs } from "../../src/persistence/migrations/0075_context_handoffs.ts";
import { Migration0077ForkConstructions } from "../../src/persistence/migrations/0077_fork_constructions.ts";
import { Migration0078SessionCheckpoints } from "../../src/persistence/migrations/0078_session_checkpoints.ts";
import { Migration0079ContextLinks } from "../../src/persistence/migrations/0079_context_links.ts";
import { Migration0080SessionDelegations } from "../../src/persistence/migrations/0080_session_delegations.ts";
import { Migration0081ProviderContexts } from "../../src/persistence/migrations/0081_provider_contexts.ts";
import { Migration0082ExecutionSteps } from "../../src/persistence/migrations/0082_execution_steps.ts";
import { Migration0083NativeCheckpointHistory } from "../../src/persistence/migrations/0083_native_checkpoint_history.ts";
import { Migration0086Automation } from "../../src/persistence/migrations/0086_automation.ts";
import { NdjsonLogger } from "../../src/persistence/ndjson-logger.ts";
import { ProviderService } from "../../src/provider/services/provider-service.ts";
import { TitleGenerator } from "../../src/provider/title-generator.ts";
import { PtyService } from "../../src/pty/services/pty-service.ts";
import { RepositorySettingsService } from "../../src/repository-settings/services/repository-settings-service.ts";
import { StubModelCatalogLive } from "../support/model-catalog-stub.ts";

const PROJECT_ID = "proj-test" as FolderId;
const TEST_WORKTREE_ID = "wt-pikachu" as WorktreeId;
const TEST_WORKTREE_PATH = "/tmp/project/.memo/pikachu";
let testCommandSequence = 0;
const testCommandId = (kind: string): string =>
	`test:${kind}:${++testCommandSequence}`;

class TestConversation extends Context.Service<
	TestConversation,
	ConversationOperations
>()("test/TestConversation") {}

const TestConversationLive = Layer.effect(
	TestConversation,
	Effect.gen(function* () {
		const sessions = yield* SessionService;
		const chats = yield* ChatService;
		const transcripts = yield* TranscriptService;
		const messages = yield* MessageService;
		const queue = yield* QueueService;
		return { ...sessions, ...chats, ...transcripts, ...messages, ...queue };
	}),
);

let scriptedEvents: ReadonlyArray<AgentEvent> = [];
let scriptedEventScope: "turn" | "session" = "turn";
let providerStartInputs: StartSessionInput[] = [];
let providerStartCursors: Array<string | null> = [];
const providerGoals = new Map<string, ThreadGoal>();
let providerSentTexts: string[] = [];
let providerSentGoals: unknown[] = [];
let providerSendAttempts = 0;
let providerBeforePublication:
	| ((sessionId: AgentSessionId, ordinal: number) => Effect.Effect<void>)
	| null = null;
let providerPublicationCount = 0;
let activeProviderSessions = new Set<AgentSessionId>();
let activeProviderResidencies = new Map<AgentSessionId, string>();
const providerTurnIds = new Map<
	AgentSessionId,
	ReturnType<typeof AgentTurnId.make>
>();
const requireProviderTurnId = (sessionId: SessionId): AgentTurnId => {
	const turnId = providerTurnIds.get(sessionId as AgentSessionId);
	if (turnId === undefined)
		throw new Error(`Missing provider turn for ${sessionId}`);
	return turnId;
};
let providerStartOrchestrationTools: Array<
	OrchestrationSessionTools | null | undefined
> = [];
let failProviderStart = false;
let providerNativeResumeFallback = false;
let failProviderSend = false;
let providerStartFailureReason = "scripted start failure";
let providerStartBarrier: Promise<void> | null = null;
let providerInterruptBarrier: Promise<void> | null = null;
let providerGoalBarrier: Promise<void> | null = null;
let providerInterruptCalls: Array<{
	readonly sessionId: AgentSessionId;
	readonly turnId: AgentTurnId;
}> = [];
let providerEventsBarrier: Promise<void> | null = null;
let providerEventsFinished: (() => void) | undefined;
let providerEventsStarted: (() => void) | undefined;
let beforeProviderWrite:
	| ((domain: SessionDomainApi, input: DispatchInput) => Effect.Effect<void>)
	| undefined;
let providerQuestionAttached = false;
let providerPlanAvailable = false;
let providerPlanResponses = 0;
let providerPlanAcknowledgements = 0;
let providerQuestionHasCalls = 0;
let detachProviderQuestionAfterHasCall: number | null = null;
let attachProviderQuestionAfterHasCall: number | null = null;
let providerAnswerAttempts = 0;
let providerAnswerPayloads: ReadonlyArray<ReadonlyArray<UserQuestionAnswer>> =
	[];
let failProviderAnswerAttempts = 0;
let providerAnswerBarrier: Promise<void> | null = null;
let providerCancelAttempts = 0;
let failProviderCancelAttempts = 0;
let providerCancelBarrier: Promise<void> | null = null;
let providerQuestionConsumed = false;
let providerQuestionContinuations = 0;
let testAutonomyLevel: AutonomyLevel = "approval-gated";
let createdWorktreeCount = 0;
let createdWorktrees = new Map<string, Worktree>();
let archivedWorktreeIds = new Set<string>();
let restoredWorktreeCount = 0;
let restoreWorktreeFailure = false;
let archiveWorktreeBarrier: Promise<void> | null = null;
let archiveWorktreeStarts = 0;
let archiveWorktreeFailure: "git-missing" | null = null;
let generatedTitle: string | null = null;
let generatedBranch: string | null = null;
let titleGenerationBarrier: Promise<void> | null = null;
let titleGenerationStarts = 0;
let renamedBranches: Array<{
	readonly worktreeId: WorktreeId;
	readonly branch: string;
}> = [];

const deferred = <A>() => {
	let resolve!: (value: A) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<A>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

const StubProviderLive = Layer.succeed(ProviderService, {
	availability: () => Effect.succeed([]),
	hasSession: (sessionId) =>
		Effect.sync(() => activeProviderSessions.has(sessionId)),
	guardCurrent: (sessionId, _generation, effect) =>
		Effect.suspend(() =>
			(
				providerBeforePublication?.(sessionId, ++providerPublicationCount) ??
				Effect.void
			).pipe(Effect.andThen(effect), Effect.as(true)),
		),
	start: (
		input,
		resumeCursor,
		_runtimeMode,
		orchestrationTools,
		_cursor,
		admit,
		residency,
	) =>
		Effect.gen(function* () {
			providerStartInputs.push(input);
			providerStartCursors.push(resumeCursor ?? null);
			providerStartOrchestrationTools.push(orchestrationTools);
			if (input.sessionId !== undefined && input.initialTurnId !== undefined) {
				providerTurnIds.set(input.sessionId, input.initialTurnId);
			}
			if (providerStartBarrier !== null) {
				yield* Effect.promise(() => providerStartBarrier as Promise<void>);
			}
			if (failProviderStart) {
				return yield* new AgentSessionStartError({
					providerId: input.providerId,
					reason: providerStartFailureReason,
				});
			}
			if (admit !== undefined && !(yield* admit))
				return {
					sessionId: input.sessionId ?? ("stub" as AgentSessionId),
					superseded: true,
				};
			const providerSessionId = residency ?? crypto.randomUUID();
			activeProviderResidencies.set(
				input.sessionId ?? ("stub" as AgentSessionId),
				providerSessionId,
			);
			activeProviderSessions.add(input.sessionId ?? ("stub" as AgentSessionId));
			return {
				nativeResumeFallback: providerNativeResumeFallback,
				...(providerBeforePublication === null ? {} : { generation: 1 }),
				providerSessionId,
				sessionId: input.sessionId ?? ("stub" as AgentSessionId),
			};
		}),
	send: (
		sessionId,
		turnId,
		text,
		_attachments,
		_files,
		_skills,
		_attempt,
		goal,
	) =>
		Effect.sync(() => {
			providerSendAttempts += 1;
			providerTurnIds.set(sessionId, turnId);
		}).pipe(
			Effect.andThen(
				failProviderSend || !activeProviderSessions.has(sessionId)
					? Effect.fail(new AgentSessionNotFoundError({ sessionId }))
					: Effect.sync(() => {
							providerSentTexts.push(text);
							if (goal !== undefined) providerSentGoals.push(goal);
						}),
			),
		),
	interrupt: (sessionId, turnId) =>
		Effect.sync(() => {
			providerInterruptCalls.push({ sessionId, turnId });
		}).pipe(
			Effect.andThen(
				providerInterruptBarrier === null
					? Effect.void
					: Effect.promise(() => providerInterruptBarrier as Promise<void>),
			),
		),
	close: (sessionId, _ownership, expected) =>
		Effect.sync(() => {
			if (
				expected !== undefined &&
				(activeProviderResidencies.get(sessionId) ?? null) !== expected
			)
				return;
			activeProviderResidencies.delete(sessionId);
			activeProviderSessions.delete(sessionId);
		}),
	events: (sessionId) =>
		Stream.suspend(() => {
			providerEventsStarted?.();
			const startup = [...providerStartInputs]
				.reverse()
				.find((input) => input.sessionId === sessionId);
			const ownership =
				startup?.initialTurnId !== undefined &&
				startup.initialAttemptId !== undefined
					? {
							turnId: startup.initialTurnId,
							attemptId: startup.initialAttemptId,
						}
					: undefined;
			const events = scriptedEvents.map((event) =>
				scriptedEventScope === "session"
					? {
							scope: "session" as const,
							providerSessionId:
								activeProviderResidencies.get(sessionId) ?? "test-residency",
							event,
						}
					: {
							scope: "turn" as const,
							...(event._tag === "NativeTurnStarted" && ownership !== undefined
								? { ownership }
								: {}),
							providerSessionId:
								activeProviderResidencies.get(sessionId) ?? "test-residency",
							turnId:
								providerTurnIds.get(sessionId) ?? AgentTurnId.make("test-turn"),
							event,
						},
			);
			const stream =
				events.length === 0
					? Stream.never
					: Stream.fromIterable(events).pipe(
							Stream.ensuring(Effect.sync(() => providerEventsFinished?.())),
						);
			return providerEventsBarrier === null
				? stream
				: Stream.fromEffect(
						Effect.promise(() => providerEventsBarrier as Promise<void>),
					).pipe(Stream.flatMap(() => stream));
		}),
	setCredential: () => Effect.succeed({ verification: "notChecked" }),
	removeCredential: () => Effect.void,
	setPermissionMode: () => Effect.void,
	questionAttachments: () =>
		Stream.succeed({ _tag: "snapshot", attachments: [] }),
	hasQuestionAttachment: () =>
		Effect.sync(() => {
			providerQuestionHasCalls += 1;
			const attached = providerQuestionAttached;
			if (providerQuestionHasCalls === attachProviderQuestionAfterHasCall) {
				providerQuestionAttached = true;
			}
			if (providerQuestionHasCalls === detachProviderQuestionAfterHasCall) {
				providerQuestionAttached = false;
			}
			return attached;
		}),
	validateQuestionAnswer: (sessionId, itemId, answers) => {
		const question = scriptedEvents.find(
			(event) => event._tag === "UserQuestion" && event.itemId === itemId,
		);
		return providerQuestionAttached &&
			question?._tag === "UserQuestion" &&
			validateUserQuestionAnswers(question.questions, answers) === undefined
			? Effect.void
			: Effect.fail(new AgentSessionNotFoundError({ sessionId }));
	},
	answerQuestion: (sessionId, _itemId, answers) =>
		Effect.gen(function* () {
			providerAnswerAttempts += 1;
			providerAnswerPayloads = [...providerAnswerPayloads, answers];
			if (!providerQuestionAttached) {
				return yield* new AgentSessionNotFoundError({ sessionId });
			}
			if (providerAnswerAttempts <= failProviderAnswerAttempts) {
				return yield* new AgentSessionNotFoundError({ sessionId });
			}
			if (providerAnswerBarrier !== null) {
				yield* Effect.promise(() => providerAnswerBarrier as Promise<void>);
			}
			if (!providerQuestionConsumed) {
				providerQuestionConsumed = true;
				providerQuestionContinuations += 1;
			}
		}),
	cancelQuestion: (sessionId) =>
		Effect.gen(function* () {
			providerCancelAttempts += 1;
			if (
				!providerQuestionAttached ||
				providerCancelAttempts <= failProviderCancelAttempts
			) {
				return yield* new AgentSessionNotFoundError({ sessionId });
			}
			if (providerCancelBarrier !== null) {
				yield* Effect.promise(() => providerCancelBarrier as Promise<void>);
			}
			if (!providerQuestionConsumed) {
				providerQuestionConsumed = true;
				providerQuestionContinuations += 1;
			}
		}),
	acknowledgeQuestionResolution: () =>
		Effect.sync(() => {
			providerQuestionAttached = false;
		}),
	acknowledgePlanResponse: () =>
		Effect.sync(() => {
			providerPlanAcknowledgements++;
		}),
	respondToPlan: (sessionId) =>
		Effect.suspend(() => {
			providerPlanResponses++;
			return providerPlanAvailable
				? Effect.void
				: Effect.fail(new AgentSessionNotFoundError({ sessionId }));
		}),
	getGoal: (sessionId, publish) =>
		Effect.sync(() => providerGoals.get(sessionId) ?? null).pipe(
			Effect.tap(
				(goal) =>
					publish?.(goal, {
						providerSessionId:
							activeProviderResidencies.get(sessionId) ?? "missing",
						providerId: "codex",
					}) ?? Effect.void,
			),
		),
	setGoal: (sessionId, input, publish) =>
		Effect.sync(() => {
			const previous = providerGoals.get(sessionId);
			const goal = ThreadGoal.make({
				threadId: sessionId,
				objective: input.objective ?? previous?.objective ?? "Test goal",
				status: input.status ?? previous?.status ?? "active",
				tokenBudget: input.tokenBudget ?? null,
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: 1,
				updatedAt: Date.now(),
			});
			providerGoals.set(sessionId, goal);
			return goal;
		}).pipe(
			Effect.tap(() =>
				providerGoalBarrier === null
					? Effect.void
					: Effect.promise(() => providerGoalBarrier as Promise<void>),
			),
			Effect.tap(
				(goal) =>
					publish?.(goal, {
						providerSessionId:
							activeProviderResidencies.get(sessionId) ?? "missing",
						providerId: "codex",
					}) ?? Effect.void,
			),
		),
	clearGoal: () => Effect.void,
});

let testWorktree = Worktree.make({
	id: TEST_WORKTREE_ID,
	projectId: PROJECT_ID,
	path: TEST_WORKTREE_PATH,
	name: "pikachu",
	branch: "pikachu",
	branchProvenance: "pending",
	baseBranch: "origin/main",
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	setupStatus: "succeeded",
	setupOutput: "",
	setupStartedAt: null,
	setupFinishedAt: null,
	pokemon: null,
});

const StubWorktreeLive = Layer.succeed(WorktreeService, {
	create: (projectId) =>
		Effect.sync(() => {
			createdWorktreeCount += 1;
			const worktree = Worktree.make({
				id: `wt-created-${createdWorktreeCount}` as WorktreeId,
				projectId,
				path: join(
					dirname(testWorktree.path),
					`created-${createdWorktreeCount}`,
				),
				name: `created-${createdWorktreeCount}`,
				branch: `created-${createdWorktreeCount}`,
				baseBranch: "origin/main",
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
				setupStatus: "succeeded",
				setupOutput: "",
				setupStartedAt: null,
				setupFinishedAt: null,
				pokemon: null,
			});
			createdWorktrees.set(worktree.id as string, worktree);
			return worktree;
		}),
	list: () => Effect.succeed([...createdWorktrees.values()]),
	get: (worktreeId) =>
		Effect.succeed(
			archivedWorktreeIds.has(worktreeId as string)
				? null
				: worktreeId === TEST_WORKTREE_ID
					? testWorktree
					: (createdWorktrees.get(worktreeId as string) ?? null),
		),
	renameBranch: (worktreeId, branch, provenance) =>
		Effect.sync(() => {
			renamedBranches.push({ worktreeId, branch });
			const current =
				worktreeId === TEST_WORKTREE_ID
					? testWorktree
					: createdWorktrees.get(worktreeId as string);
			if (current === undefined) throw new Error("missing test worktree");
			const renamed = Worktree.make({
				...current,
				branch,
				branchProvenance: provenance,
			});
			if (worktreeId === TEST_WORKTREE_ID) testWorktree = renamed;
			else createdWorktrees.set(worktreeId as string, renamed);
			return renamed;
		}),
	archive: (worktreeId, recordCheckpoint, allowRemoval) =>
		Effect.gen(function* () {
			archiveWorktreeStarts += 1;
			if (archiveWorktreeFailure === "git-missing") {
				return yield* new WorktreeCheckpointError({
					worktreeId,
					reason: "git is not installed",
				});
			}
			if (archiveWorktreeBarrier !== null) {
				yield* Effect.promise(() => archiveWorktreeBarrier as Promise<void>);
			}
			const outcome = {
				archiveCommit: "checkpoint-sha",
				checkpointCreated: false,
				archiveRef: null,
				archivedContextPath: null,
				branch:
					worktreeId === TEST_WORKTREE_ID ? testWorktree.branch : "fixture",
				detachedHead: false,
				branchProvenance: "manual" as const,
				pokemonNumber: null,
			};
			const markRemoved = Effect.gen(function* () {
				if (allowRemoval !== undefined && !(yield* allowRemoval())) return;
				archivedWorktreeIds.add(worktreeId as string);
			});
			return yield* recordCheckpoint === undefined
				? markRemoved.pipe(Effect.as(outcome))
				: recordCheckpoint(outcome).pipe(
						Effect.andThen(markRemoved),
						Effect.as(outcome),
					);
		}),
	remove: () => Effect.void,
	rerunSetup: () => Effect.die("not used"),
	setupStream: () => Stream.die("not used"),
	startRun: () => Effect.die("not used"),
	restore: (snapshot) =>
		Effect.gen(function* () {
			restoredWorktreeCount += 1;
			if (restoreWorktreeFailure) {
				return yield* new WorktreeRestoreError({
					worktreeId: snapshot.id,
					reason: "simulated restore failure",
				});
			}
			archivedWorktreeIds.delete(snapshot.id as string);
			const worktree =
				snapshot.id === TEST_WORKTREE_ID
					? testWorktree
					: (createdWorktrees.get(snapshot.id as string) ?? testWorktree);
			return { worktree, checkpoint: "applied" as const };
		}),
});

const StubGitLive = Layer.succeed(GitService, {
	githubContext: () => Effect.succeed(null),
	isRepository: () => Effect.succeed(true),
	ignoredDirectories: () => Effect.succeed(new Set<string>()),
	log: () => Effect.die("not used"),
	status: () => Effect.die("not used"),
	branches: () => Effect.die("not used"),
	switchBranch: () => Effect.die("not used"),
	stack: () => Effect.die("not used"),
	renameBranch: () => Effect.die("not used"),
	getUserName: () => Effect.succeed(""),
	workspaceChanges: () => Stream.die("not used"),
	workspaceSnapshot: () => Effect.die("not used"),
	origin: () => Effect.die("not used"),
	prState: () => Effect.die("not used"),
	prDetails: () => Effect.die("not used"),
	createReviewComment: () => Effect.succeed({ url: null }),
	reviewIdentity: () => Effect.succeed(null),
	starZuse: () => Effect.void,
	zuseStarStatus: () => Effect.succeed(false),
	listPrs: () => Effect.die("not used"),
	listIssues: () => Effect.die("not used"),
	issueMarkdown: () => Effect.die("not used"),
	changes: () => Effect.die("not used"),
	diff: () => Effect.die("not used"),
	reviewSummary: () => Effect.die("not used"),
	reviewPatches: () => Stream.die("not used"),
	reviewFileContents: () => Effect.die("not used"),
	commit: () => Effect.die("not used"),
	push: () => Effect.die("not used"),
	pull: () => Effect.die("not used"),
	stash: () => Effect.die("not used"),
	stashPop: () => Effect.die("not used"),
	resetRemotePreview: () => Effect.die("not used"),
	resetRemoteApply: () => Effect.die("not used"),
	resolveConflict: () => Effect.die("not used"),
	mergePr: () => Effect.die("not used"),
	markReady: () => Effect.die("not used"),
	init: () => Effect.die("not used"),
	revertFile: () => Effect.die("not used"),
	revertAll: () => Effect.die("not used"),
	restoreFileToBase: () => Effect.die("not used"),
	fixFailingChecks: () => Effect.die("not used"),
});

const StubTitleGeneratorLive = Layer.succeed(TitleGenerator, {
	generate: (input) =>
		Effect.gen(function* () {
			titleGenerationStarts += 1;
			if (titleGenerationBarrier !== null) {
				yield* Effect.promise(() => titleGenerationBarrier as Promise<void>);
			}
			if (generatedTitle === null && generatedBranch === null)
				return yield* Effect.die("not used");
			return {
				title: input.title ? generatedTitle : null,
				branch: input.branch ? generatedBranch : null,
			};
		}),
});

const StubConfigStoreLive = Layer.succeed(ConfigStoreService, {
	getSettings: () =>
		Effect.succeed({
			defaultAutonomyLevel: testAutonomyLevel,
			customModelIdsByProvider: {},
			modelEnabledByProvider: {},
			providerEnabled: {},
			acpProviders: [],
			defaultModelByProvider: {
				claude: defaultModelFor(BUNDLED_MODEL_CATALOG, "claude"),
				codex: defaultModelFor(BUNDLED_MODEL_CATALOG, "codex"),
				grok: defaultModelFor(BUNDLED_MODEL_CATALOG, "grok"),
				cursor: defaultModelFor(BUNDLED_MODEL_CATALOG, "cursor"),
				gemini: defaultModelFor(BUNDLED_MODEL_CATALOG, "gemini"),
				opencode: defaultModelFor(BUNDLED_MODEL_CATALOG, "opencode"),
				opencode2: defaultModelFor(BUNDLED_MODEL_CATALOG, "opencode2"),
				kiro: defaultModelFor(BUNDLED_MODEL_CATALOG, "kiro"),
			},
			branchNamingStyle: "slug",
			branchNamingPrefix: "",
		} as never),
	updateSettings: () => Effect.die("not used"),
	settingsChanges: () => Stream.die("not used"),
	migrateLocalStorage: () => Effect.die("not used"),
	getKeybindings: () => Effect.die("not used"),
	replaceKeybindings: () => Effect.die("not used"),
	keybindingsChanges: () => Stream.die("not used"),
});

const StubApiActivityPublisherLive = Layer.succeed(ApiActivityPublisher, {
	publish: () => Effect.void,
});

const StubRepositorySettingsLive = Layer.succeed(RepositorySettingsService, {
	get: (projectId) =>
		Effect.succeed(
			RepositorySettings.make({
				projectId,
				defaultProviderId: null,
				defaultModel: null,
				defaultRuntimeMode: null,
				autoCreateWorktree: false,
				worktreeBaseDir: null,
				archiveCleanupScript: null,
				setupScript: null,
				runScript: null,
				autoRunAfterSetup: false,
				environmentVariables: {},
				cloudEnvironmentVariables: {},
				fileIncludeGlobs: "",
			}),
		),
	update: (projectId, patch) =>
		Effect.succeed(
			RepositorySettings.make({
				projectId,
				defaultProviderId: patch.defaultProviderId ?? null,
				defaultModel: patch.defaultModel ?? null,
				defaultRuntimeMode: patch.defaultRuntimeMode ?? null,
				autoCreateWorktree: patch.autoCreateWorktree ?? false,
				worktreeBaseDir: patch.worktreeBaseDir ?? null,
				archiveCleanupScript: patch.archiveCleanupScript ?? null,
				setupScript: patch.setupScript ?? null,
				runScript: patch.runScript ?? null,
				autoRunAfterSetup: patch.autoRunAfterSetup ?? false,
				environmentVariables: patch.environmentVariables ?? {},
				cloudEnvironmentVariables: patch.cloudEnvironmentVariables ?? {},
				fileIncludeGlobs: patch.fileIncludeGlobs ?? "",
			}),
		),
});

const StubPtyLive = Layer.succeed(PtyService, {
	open: () => Effect.die("not used"),
	list: () => Effect.succeed(PtyCatalog.make({ terminals: [], liveLimit: 1 })),
	write: () => Effect.die("not used"),
	resize: () => Effect.die("not used"),
	rename: () => Effect.die("not used"),
	restart: () => Effect.die("not used"),
	close: () => Effect.die("not used"),
	closeOwned: () => Effect.succeed(0),
	closeByCwdPrefix: () => Effect.void,
	subscribe: () => Stream.die("not used"),
});

const StubNdjsonLive = Layer.succeed(NdjsonLogger, {
	append: () => Effect.void,
	close: () => Effect.void,
});

const runAllMigrations = Effect.all(
	[
		Migration0001Initial,
		Migration0002Permissions,
		Migration0003ResumeAndExport,
		Migration0004PermissionScope,
		Migration0005RuntimeMode,
		Migration0006Attachments,
		Migration0007Subagents,
		Migration0008WorktreesAndRepoSettings,
		Migration0009PermissionModeAndToolSearch,
		Migration0010NestedSessions,
		Migration0011ChatsTable,
		Migration0012ChatIdNotNull,
		Migration0013ArchiveCleanup,
		Migration0014ScriptsAndSetup,
		Migration0015QueuedMessages,
		Migration0016QueuedMessagesQueueOrderRepair,
		Migration0017ChatReadState,
		Migration0018PokemonWorktrees,
		Migration0019QueuePaused,
		Migration0020Events,
		Migration0023ChatLineage,
		Migration0029ChatLineageRepair,
		Migration0030CqrsEngine,
		Migration0031BackfillRuns,
		Migration0032ReactorEffectReceipts,
		Migration0033ReactorEffectSteps,
		Migration0034ToolEventLookup,
		Migration0037ProviderEventCursor,
		Migration0038QueuedMessageReady,
		Migration0041ChatArchiveJobs,
		Migration0043NameProvenance,
		Migration0045ChatCatalogRevision,
		Migration0046SessionTimelineHead,
		Migration0047MessageCheckpoints,
		Migration0053CloudCommandReceipts,
		Migration0054ProviderEffectOutcomes,
		Migration0058QuestionAnswerDeliveries,
		Migration0060ChatUserMessageTime,
		Migration0063Jobs,
		Migration0064SessionGraph,
		Migration0067ProviderReservations,
		Migration0068AttemptHistory,
		Migration0069AttemptProviderTurn,
		Migration0070IngestionLeases,
		Migration0071SessionInputs,
		Migration0072InputOwnership,
		Migration0073QuestionExpiry,
		Migration0074PlanDeliveries,
		Migration0075ContextHandoffs,
		Migration0077ForkConstructions,
		Migration0079ContextLinks,
		Migration0080SessionDelegations,
		Migration0082ExecutionSteps,
		Migration0081ProviderContexts,
		Migration0078SessionCheckpoints,
		Migration0083NativeCheckpointHistory,
		Migration0086Automation,
	],
	{ discard: true },
);

let queueAuthorAllowed = true;
let queueAuthorWait: Effect.Effect<void> = Effect.void;
let workspacePreparation: Effect.Effect<void> = Effect.void;
const makeRuntime = (dbPath: string, migrate = true) => {
	const SqlLive = sqliteLayer({ filename: dbPath });

	const Migrated = migrate
		? Layer.effectDiscard(runAllMigrations).pipe(Layer.provideMerge(SqlLive))
		: SqlLive;
	const BaseDomainLive = SessionDomain.layer.pipe(
		Layer.provide(Migrated),
		Layer.provide(NodeServices.layer),
	);
	const DomainLive = Layer.effect(
		SessionDomain,
		Effect.map(SessionDomain, (domain) => ({
			...domain,
			dispatch: (input) =>
				Effect.suspend(
					() => beforeProviderWrite?.(domain, input) ?? Effect.void,
				).pipe(Effect.andThen(domain.dispatch(input))),
			dispatchTransactionally: (input, effect) =>
				Effect.suspend(
					() => beforeProviderWrite?.(domain, input) ?? Effect.void,
				).pipe(Effect.andThen(domain.dispatchTransactionally(input, effect))),
		})),
	).pipe(Layer.provide(BaseDomainLive));
	const ChatDomainLive = ChatDomain.layer.pipe(
		Layer.provide(Migrated),
		Layer.provide(NodeServices.layer),
	);
	const SessionQueriesLive = SqlSessionQueries.layer.pipe(
		Layer.provide(Migrated),
	);
	const ConversationLayer = ConversationServicesLive.pipe(
		Layer.provide(
			Layer.succeed(CheckpointFiles, {
				capture: async () => ({ commit: "fixture-checkpoint" }),
			}),
		),
		Layer.provide(
			Layer.succeed(WorkspaceExecutionPolicy, {
				get isReady() {
					return workspacePreparation === Effect.void;
				},
				awaitReady: Effect.suspend(() => workspacePreparation),
				markReady: Effect.void,
				authorize: () =>
					queueAuthorWait.pipe(
						Effect.andThen(Effect.sync(() => queueAuthorAllowed)),
					),
				bind: () => Effect.void,
			}),
		),
		Layer.provideMerge(ConversationState.layer),
		Layer.provide(StubProviderLive),
		Layer.provide(StubWorktreeLive),
		Layer.provide(StubRepositorySettingsLive),
		Layer.provide(StubPtyLive),
		Layer.provide(StubNdjsonLive),
		Layer.provide(StubGitLive),
		Layer.provide(StubTitleGeneratorLive),
		Layer.provide(StubConfigStoreLive),
		Layer.provide(StubModelCatalogLive),
		Layer.provide(StubApiActivityPublisherLive),
		Layer.provideMerge(DomainLive),
		Layer.provide(ChatDomainLive),
		Layer.provide(SessionQueriesLive),
		Layer.provide(NodeServices.layer),

		Layer.provideMerge(Migrated),
	);
	const TestLayer = TestConversationLive.pipe(
		Layer.provideMerge(ConversationLayer),
	);
	return ManagedRuntime.make(TestLayer);
};

const withRuntime = async <A>(
	fn: (
		run: <X>(
			eff: Effect.Effect<
				X,
				unknown,
				| TestConversation
				| SqlClient.SqlClient
				| SessionDomain
				| ConversationState
			>,
		) => Promise<X>,
		dbPath: string,
	) => Promise<A>,
): Promise<A> => {
	const dir = mkdtempSync(join(tmpdir(), "mz-msgstore-"));
	const dbPath = join(dir, "test.sqlite");
	testWorktree = Worktree.make({
		...testWorktree,
		path: join(dir, "pikachu"),
	});
	mkdirSync(testWorktree.path, { recursive: true });
	const runtime = makeRuntime(dbPath);
	const run = <X>(
		eff: Effect.Effect<
			X,
			unknown,
			TestConversation | SqlClient.SqlClient | SessionDomain | ConversationState
		>,
	): Promise<X> => runtime.runPromise(eff as Effect.Effect<X, unknown, never>);
	try {
		await run(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const now = new Date().toISOString();
				yield* sql`
          INSERT INTO projects (id, path, name, created_at, updated_at)
          VALUES (${PROJECT_ID}, ${dir}, ${"Test"}, ${now}, ${now})
        `;
				yield* sql`
          INSERT INTO worktrees
            (id, project_id, path, name, branch, branch_provenance, base_branch, created_at)
          VALUES
            (${TEST_WORKTREE_ID}, ${PROJECT_ID}, ${testWorktree.path},
             ${testWorktree.name}, ${testWorktree.branch},
             ${"pending"}, ${testWorktree.baseBranch}, ${now}),
			(${"wt-created-1"}, ${PROJECT_ID},
			 ${join(dirname(testWorktree.path), "created-1")}, ${"created-1"},
             ${"created-1"}, ${"pending"}, ${"origin/main"}, ${now})
        `;
			}),
		);
		return await fn(run, dbPath);
	} finally {
		await runtime.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
};

const store = TestConversation;

beforeEach(() => {
	queueAuthorAllowed = true;
	queueAuthorWait = Effect.void;
	workspacePreparation = Effect.void;
	providerBeforePublication = null;
	providerPublicationCount = 0;
	providerGoals.clear();
	testCommandSequence = 0;
	providerStartInputs = [];
	providerStartCursors = [];
	providerSentTexts = [];
	providerSentGoals = [];
	providerTurnIds.clear();
	providerSendAttempts = 0;
	activeProviderSessions = new Set();
	activeProviderResidencies = new Map();
	providerStartOrchestrationTools = [];
	failProviderStart = false;
	providerNativeResumeFallback = false;
	failProviderSend = false;
	providerStartFailureReason = "scripted start failure";
	providerStartBarrier = null;
	providerInterruptBarrier = null;
	providerGoalBarrier = null;
	providerInterruptCalls = [];
	providerEventsBarrier = null;
	providerEventsFinished = undefined;
	providerEventsStarted = undefined;
	beforeProviderWrite = undefined;
	providerQuestionAttached = false;
	providerPlanAvailable = false;
	providerPlanResponses = 0;
	providerPlanAcknowledgements = 0;
	providerQuestionHasCalls = 0;
	detachProviderQuestionAfterHasCall = null;
	attachProviderQuestionAfterHasCall = null;
	providerAnswerAttempts = 0;
	providerAnswerPayloads = [];
	failProviderAnswerAttempts = 0;
	providerAnswerBarrier = null;
	providerCancelAttempts = 0;
	failProviderCancelAttempts = 0;
	providerCancelBarrier = null;
	providerQuestionConsumed = false;
	providerQuestionContinuations = 0;
	testAutonomyLevel = "approval-gated";
	createdWorktreeCount = 0;
	createdWorktrees = new Map();
	archivedWorktreeIds = new Set();
	restoredWorktreeCount = 0;
	restoreWorktreeFailure = false;
	archiveWorktreeBarrier = null;
	archiveWorktreeStarts = 0;
	archiveWorktreeFailure = null;
	generatedTitle = null;
	generatedBranch = null;
	titleGenerationBarrier = null;
	titleGenerationStarts = 0;
	renamedBranches = [];
	testWorktree = Worktree.make({
		...testWorktree,
		path: TEST_WORKTREE_PATH,
		branch: "pikachu",
		branchProvenance: "pending",
	});
});

describe("ConversationServices migrations", () => {
	it.each([
		1, 2,
	])("rejects stale startup publication %s inside the transaction", async (publication) => {
		await withRuntime(async (run) => {
			providerBeforePublication = (sessionId, ordinal) =>
				ordinal !== publication
					? Effect.void
					: Effect.promise(() =>
							run(
								Effect.gen(function* () {
									const domain = yield* SessionDomain;
									const current = yield* domain.activeAttempt(sessionId);
									if (current === null)
										throw new Error("Expected startup attempt");
									yield* domain.dispatch({
										commandId: `settle-during-publication-${publication}`,
										streamId: sessionId,
										command: {
											_tag: "SettleTurn",
											turnId: current.turnId,
											outcome: "completed",
											settledAt: Date.now(),
										},
									});
								}),
							),
						);
			const chat = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "startup race",
					}),
				),
			);
			await expect
				.poll(() =>
					run(
						Effect.flatMap(SessionDomain, (domain) =>
							domain.jobs
								.listBySession(chat.initialSession.id)
								.pipe(
									Effect.map((jobs) =>
										jobs
											.filter(
												(job) => job.request._tag === "provider.turn.send",
											)
											.map((job) => job.status),
									),
								),
						),
					),
				)
				.toEqual(["succeeded"]);
			const result = await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const sessions = yield* sql<{
						status: string;
					}>`SELECT status FROM sessions WHERE id = ${chat.initialSession.id}`;
					const attached =
						yield* sql`SELECT event_id FROM events WHERE stream_id = ${chat.initialSession.id} AND type = 'ProviderAttached'`;
					return { status: sessions[0]?.status, attached: attached.length };
				}),
			);
			expect(result).toEqual({
				status: "idle",
				attached: publication === 1 ? 0 : 1,
			});
			expect(providerSentTexts).toEqual([]);
		});
	});

	it.each([
		"acquisition",
		"attach",
		"status",
	] as const)("revokes provider startup during %s without sending a prompt", async (stage) => {
		const gate = deferred<void>();
		if (stage === "acquisition") providerStartBarrier = gate.promise;
		try {
			await withRuntime(async (run) => {
				const stop = (sessionId: string) =>
					run(
						Effect.flatMap(SessionDomain, (domain) =>
							domain.dispatch({
								commandId: `stop-during-${stage}`,
								streamId: sessionId,
								command: {
									_tag: "RequestProviderStop",
									requestedAt: Date.now(),
								},
							}),
						),
					);
				if (stage !== "acquisition")
					providerBeforePublication = (sessionId, ordinal) =>
						ordinal === (stage === "attach" ? 1 : 2)
							? Effect.promise(() => stop(sessionId)).pipe(Effect.asVoid)
							: Effect.void;
				const { initialSession } = await run(
					Effect.flatMap(store, (service) =>
						service.createChat({
							projectId: PROJECT_ID,
							providerId: "claude",
							model: "claude-opus-4-8",
							initialPrompt: "must not be sent",
						}),
					),
				);
				if (stage === "acquisition") {
					await expect.poll(() => providerStartInputs.length).toBe(1);
					expect(
						await run(
							Effect.flatMap(SessionDomain, (domain) =>
								domain.providerReservation(initialSession.id),
							),
						),
					).not.toBeNull();
					await stop(initialSession.id);
					gate.resolve();
				}
				await expect
					.poll(() =>
						run(
							Effect.flatMap(SessionDomain, (domain) =>
								domain.jobs
									.listBySession(initialSession.id)
									.pipe(
										Effect.map((jobs) =>
											jobs
												.filter(
													(job) => job.request._tag === "provider.turn.send",
												)
												.map((job) => job.status),
										),
									),
							),
						),
					)
					.toEqual(["succeeded"]);
				expect(
					await run(
						Effect.flatMap(SessionDomain, (domain) =>
							domain.providerReservation(initialSession.id),
						),
					),
				).toBeNull();
				const attachments = await run(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						return yield* sql`SELECT event_id FROM events WHERE stream_id = ${initialSession.id} AND type = 'ProviderAttached'`;
					}),
				);
				expect(attachments).toHaveLength(stage === "status" ? 1 : 0);
				expect(activeProviderSessions.has(initialSession.id)).toBe(false);
				expect(providerSentTexts).toEqual([]);
			});
		} finally {
			gate.resolve();
			providerStartBarrier = null;
			providerBeforePublication = null;
		}
	});

	it("0016 repairs queued_messages rows from the old position column", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mz-queue-migration-"));
		const dbPath = join(dir, "test.sqlite");
		const runtime = ManagedRuntime.make(sqliteLayer({ filename: dbPath }));
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
            CREATE TABLE queued_messages (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              position INTEGER NOT NULL,
              input_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
          `;
					yield* sql`
            INSERT INTO queued_messages
              (id, session_id, position, input_json, created_at, updated_at)
            VALUES
              ('q1', 's1', 7, '{"text":"x","attachments":[],"fileRefs":[],"skillRefs":[]}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
          `;
					yield* Migration0016QueuedMessagesQueueOrderRepair;
					const columns = yield* sql<{ readonly name: string }>`
            PRAGMA table_info(queued_messages)
          `;
					expect(columns.map((column) => column.name)).toContain("queue_order");
					const rows = yield* sql<{ readonly queue_order: number }>`
            SELECT queue_order FROM queued_messages WHERE id = 'q1'
          `;
					expect(rows[0]?.queue_order).toBe(7);
				}),
			);
		} finally {
			await runtime.dispose();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("0019 adds queue_paused to sessions with a default of 0", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const row = await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const rows = yield* sql<{ readonly queue_paused: number }>`
            SELECT queue_paused
            FROM sessions
            WHERE id = ${initialSession.id}
          `;
					return rows[0];
				}),
			);
			expect(row?.queue_paused).toBe(0);
		});
	});

	it("0029 repairs databases that skipped chat lineage", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mz-chat-lineage-repair-"));
		const dbPath = join(dir, "test.sqlite");
		const runtime = ManagedRuntime.make(sqliteLayer({ filename: dbPath }));
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
            CREATE TABLE projects (
              id TEXT PRIMARY KEY,
              path TEXT NOT NULL UNIQUE,
              name TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
          `;
					yield* sql`
            CREATE TABLE chats (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              worktree_id TEXT,
              title TEXT NOT NULL,
              active_session_id TEXT,
              archived_at TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              archived_worktree_json TEXT,
              last_message_at TEXT,
              last_read_at TEXT
            )
          `;

					yield* Migration0029ChatLineageRepair;
					yield* Migration0029ChatLineageRepair;

					const columns = yield* sql<{ readonly name: string }>`
            PRAGMA table_info(chats)
          `;
					expect(columns.map((column) => column.name)).toContain(
						"origin_session_id",
					);
				}),
			);
		} finally {
			await runtime.dispose();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("ConversationServices — chat & session lifecycle", () => {
	it("never delivers a prompt stopped while repository preparation is pending", async () => {
		const ready = await Effect.runPromise(Deferred.make<void>());
		const waiting = await Effect.runPromise(Deferred.make<void>());
		workspacePreparation = Deferred.succeed(waiting, undefined).pipe(
			Effect.andThen(Deferred.await(ready)),
		);
		await withRuntime(async (run) => {
			const created = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			await run(
				Effect.flatMap(store, (service) =>
					service.sendMessageWithInput({
						commandId: "cancel-preparation-prompt",
						sessionId: created.initialSession.id,
						text: "this must never reach the agent",
					}),
				),
			);
			await Effect.runPromise(Deferred.await(waiting));
			const stopped = run(
				Effect.flatMap(store, (service) =>
					service.interruptSession(
						testCommandId("messages.interrupt"),
						created.initialSession.id,
					),
				).pipe(Effect.timeout("1 second")),
			);
			await expect
				.poll(
					async () =>
						(
							await run(
								Effect.gen(function* () {
									const sql = yield* SqlClient.SqlClient;
									return yield* sql`SELECT type FROM events WHERE stream_id = ${created.initialSession.id} AND type = 'TurnInterruptRequested'`;
								}),
							)
						).length,
				)
				.toBe(1);
			await stopped;
			expect(providerStartInputs).toHaveLength(0);
			expect(providerSentTexts).toEqual([]);
			workspacePreparation = Effect.void;
			await Effect.runPromise(Deferred.succeed(ready, undefined));
			await run(
				Effect.flatMap(store, (service) =>
					service.interruptSession(
						testCommandId("messages.interrupt"),
						created.initialSession.id,
					),
				),
			);
			expect(providerStartInputs).toHaveLength(0);
			expect(providerSentTexts).toEqual([]);
		});
	});

	it("returns the chat and durably accepts a direct prompt while repository preparation blocks execution", async () => {
		const ready = await Effect.runPromise(Deferred.make<void>());
		workspacePreparation = Deferred.await(ready);
		await withRuntime(async (run) => {
			const created = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			await run(
				Effect.flatMap(store, (service) =>
					service.sendMessageWithInput({
						commandId: "preparation-prompt",
						sessionId: created.initialSession.id,
						text: "wait for the correct checkout",
					}),
				),
			);
			const messages = await run(
				Effect.flatMap(store, (service) =>
					service.listMessages(created.initialSession.id),
				),
			);
			expect(
				messages.some(
					(message) =>
						message.content._tag === "user" &&
						message.content.text === "wait for the correct checkout",
				),
			).toBe(true);
			expect(providerStartInputs).toHaveLength(0);
			const attempts = await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					return yield* sql`SELECT effect_id FROM reactor_effect_receipts WHERE effect_id IN (SELECT id FROM jobs WHERE session_id = ${created.initialSession.id})`;
				}),
			);
			expect(attempts).toHaveLength(0);
			workspacePreparation = Effect.void;
			await Effect.runPromise(Deferred.succeed(ready, undefined));
			await expect.poll(() => providerStartInputs.length).toBe(1);
			await expect
				.poll(() => providerSentTexts)
				.toEqual(["wait for the correct checkout"]);
		});
	});

	it("retains an unclaimed prompt across runtime restart during repository preparation", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-preparation-restart-"));
		const dbPath = join(directory, "test.sqlite");
		testWorktree = Worktree.make({
			...testWorktree,
			path: join(directory, "pikachu"),
		});
		mkdirSync(testWorktree.path, { recursive: true });
		const ready = await Effect.runPromise(Deferred.make<void>());
		workspacePreparation = Deferred.await(ready);
		const first = makeRuntime(dbPath);
		const runFirst = <A>(effect: Effect.Effect<A, unknown, unknown>) =>
			first.runPromise(effect as Effect.Effect<A, unknown, never>);
		try {
			await runFirst(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const now = new Date().toISOString();
					yield* sql`INSERT INTO projects (id, path, name, created_at, updated_at)
					VALUES (${PROJECT_ID}, ${directory}, ${"Test"}, ${now}, ${now})`;
				}),
			);
			const { initialSession } = await runFirst(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			await runFirst(
				Effect.flatMap(store, (service) =>
					service.sendMessageWithInput({
						commandId: "restart-preparation-prompt",
						sessionId: initialSession.id,
						text: "retain this until the checkout is ready",
					}),
				),
			);
			const inspect = Effect.flatMap(
				SqlClient.SqlClient,
				(sql) =>
					sql<{
						status: string;
						attempt_count: number;
					}>`SELECT status, attempt_count FROM jobs
					WHERE session_id = ${initialSession.id} AND kind = 'provider.turn.send'`,
			);
			expect(await runFirst(inspect)).toEqual([
				{ status: "pending", attempt_count: 0 },
			]);
			await first.dispose();
			const restarted = makeRuntime(dbPath, false);
			try {
				expect(await restarted.runPromise(inspect)).toEqual([
					{ status: "pending", attempt_count: 0 },
				]);
				expect(providerStartInputs).toHaveLength(0);
				expect(providerSentTexts).toEqual([]);
				workspacePreparation = Effect.void;
				await Effect.runPromise(Deferred.succeed(ready, undefined));
				await expect
					.poll(() => providerSentTexts)
					.toEqual(["retain this until the checkout is ready"]);
				expect(providerStartInputs).toHaveLength(1);
			} finally {
				await restarted.dispose();
			}
		} finally {
			await first.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("keeps an empty session dormant even when provider startup would fail", async () => {
		await withRuntime(async (run) => {
			failProviderStart = true;
			const created = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			expect(created.initialSession.status).toBe("idle");
			expect(providerStartInputs).toEqual([]);
		});
	});

	it("rejects a new send while a durable exact turn is active", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			await expect
				.poll(async () =>
					run(
						Effect.flatMap(store, (service) =>
							service.getSession(initialSession.id),
						),
					),
				)
				.toMatchObject({ status: "idle" });

			await new Promise<void>((resolve) => setImmediate(resolve));
			await run(
				Effect.gen(function* () {
					const domain = yield* SessionDomain;
					const state = yield* ConversationState;
					yield* domain.dispatch({
						commandId: "test:durable-turn",
						streamId: initialSession.id,
						command: {
							_tag: "StartTurn",
							turnId: "turn-durable",
							startedAt: 1,
						},
					});
					state.clearActiveTurn(initialSession.id);
				}),
			);

			const send = await run(
				Effect.flatMap(store, (service) =>
					Effect.exit(
						service.sendMessage(
							testCommandId("messages.send"),
							initialSession.id,
							"must not overlap",
						),
					),
				),
			);
			expect(send._tag).toBe("Failure");
			const evidence = await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const turns = yield* sql<{ readonly count: number }>`
						SELECT COUNT(*) AS count FROM events
						WHERE stream_id = ${initialSession.id} AND type = 'TurnStarted'
					`;
					const messages = yield* sql<{ readonly payload_json: string }>`
						SELECT payload_json FROM events
						WHERE stream_id = ${initialSession.id} AND type = 'MessagePersisted'
						ORDER BY sequence DESC LIMIT 1
					`;
					return { turns, messages };
				}),
			);
			expect(evidence.turns[0]?.count).toBe(1);
			expect(evidence.messages).toEqual([]);
		});
	});

	it("starts providers through the durable provider turn job", async () => {
		await withRuntime(async (run) => {
			const created = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "start lazily",
					}),
				),
			);
			await expect.poll(() => providerStartInputs.length).toBe(1);
			await expect
				.poll(() =>
					run(
						Effect.flatMap(SessionDomain, (domain) =>
							domain.jobs.listBySession(created.initialSession.id),
						),
					).then((jobs) =>
						jobs
							.filter((job) => job.request._tag === "provider.turn.send")
							.map((job) => job.status),
					),
				)
				.toEqual(["succeeded"]);
			const evidence = await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const events = yield* sql<{
						readonly event_id: string;
						readonly payload_json: string;
					}>`
            SELECT event_id, payload_json FROM events
            WHERE stream_id = ${created.initialSession.id}
              AND type = 'SessionCreated'
          `;
					const domain = yield* SessionDomain;
					const jobs = yield* domain.jobs.listBySession(
						created.initialSession.id,
					);
					return { events, jobs };
				}),
			);

			expect(providerStartInputs).toHaveLength(1);
			expect(evidence.events).toHaveLength(1);
			expect(
				JSON.parse(evidence.events[0]?.payload_json ?? "null"),
			).toMatchObject({ _tag: "SessionCreated" });
			const sendJob = evidence.jobs.find(
				(job) => job.request._tag === "provider.turn.send",
			);
			expect(sendJob).toMatchObject({ status: "succeeded", attemptCount: 1 });
			expect(sendJob?.causationEventId).toBeTruthy();
		});
	});

	it("returns the durable result when the same chat bootstrap is retried", async () => {
		await withRuntime(async (run) => {
			const retryChatId = ChatId.make("chat-retry-after-lost-ack");
			const retrySessionId = SessionId.make("session-retry-after-lost-ack");
			const input = {
				chatId: retryChatId,
				initialSessionId: retrySessionId,
				commandId: "chat-create:retry-after-lost-ack:bootstrap",
				initialTurnId: AgentTurnId.make("turn-retry-after-lost-ack"),
				initialMessageId: MessageId.make("message-retry-after-lost-ack"),
				projectId: PROJECT_ID,
				providerId: "claude" as const,
				model: "claude-opus-4-8",
				initialPrompt: "retry exactly once",
				background: true,
			};

			const first = await run(
				Effect.flatMap(store, (service) => service.createChat(input)),
			);

			await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`INSERT INTO messages (id, session_id, role, kind, content_json, created_at, sequence)
					SELECT 'later-backdated-message', ${retrySessionId}, 'user', 'user',
					'{"_tag":"user","text":"later prompt","goal":false}', '2000-01-01T00:00:00.000Z', COALESCE(MAX(sequence), 0) + 1
					FROM messages WHERE session_id = ${retrySessionId}`;
				}),
			);

			const retried = await run(
				Effect.flatMap(store, (service) => service.createChat(input)),
			);

			expect(retried.chat.id).toBe(first.chat.id);
			expect(retried.initialSession.id).toBe(first.initialSession.id);
			expect(retried.initialMessage?.id).toBe(input.initialMessageId);
			expect(providerStartInputs).toHaveLength(1);
		});
	});

	it("accepts a stable bootstrap replay for a matching legacy session", async () => {
		await withRuntime(async (run) => {
			const chatId = ChatId.make("chat-legacy-bootstrap-replay");
			const sessionId = SessionId.make("session-legacy-bootstrap-replay");
			const legacy = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						chatId,
						initialSessionId: sessionId,
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "resume the legacy operation",
						background: true,
					}),
				),
			);

			const replayed = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						chatId,
						initialSessionId: sessionId,
						commandId: "chat-create:legacy-bootstrap-replay:bootstrap",
						initialTurnId: AgentTurnId.make("turn_legacy-bootstrap-replay"),
						initialMessageId: MessageId.make("message_legacy-bootstrap-replay"),
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "resume the legacy operation",
						background: true,
					}),
				),
			);

			expect(replayed.chat.id).toBe(legacy.chat.id);
			expect(replayed.initialSession.id).toBe(legacy.initialSession.id);
		});
	});

	it("replays a cloud launch receipt without duplicating its prompt or turn", async () => {
		await withRuntime(async (run) => {
			const commandId = "launch:workspace-lost-ack";
			const turnId = "turn:workspace-lost-ack";
			const chatId = ChatId.make("chat-cloud-launch-lost-ack");
			const sessionId = SessionId.make("session-cloud-launch-lost-ack");
			const workspaces = {
				list: () =>
					Effect.succeed([{ id: PROJECT_ID, path: "/home/zuse/workspace" }]),
				add: () => Effect.die("workspace already registered"),
			} as never;
			const chats = await run(Effect.flatMap(store, Effect.succeed));
			const launch = startCloudWorkspaceLaunchIntent({
				workspaces,
				chats,
				chatId,
				sessionId,
				workspaceRoot: "/home/zuse/workspace",
				launchIntent: {
					commandId,
					turnId,
					title: "Durable cloud launch",
					agent: "claude",
					model: "claude-opus-4-8",
					runtimeMode: "full-access",
					permissions: [],
					firstMessage: "finish after the client closes",
				},
			});

			await run(launch);

			await run(launch);
			await expect.poll(() => providerStartInputs.length).toBe(1);

			const evidence = await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const messages = yield* sql<{
						readonly id: string;
						readonly content_json: string;
					}>`
						SELECT id, content_json FROM messages
						WHERE session_id = ${sessionId} AND role = 'user'
					`;
					const turns = yield* sql<{
						readonly payload_json: string;
					}>`
						SELECT payload_json FROM events
						WHERE stream_id = ${sessionId} AND type = 'TurnStarted'
					`;
					const receipts = yield* sql<{
						readonly stream_id: string;
					}>`
						SELECT stream_id FROM command_receipts
						WHERE command_id = ${commandId}
					`;
					const sessions = yield* sql<{
						readonly runtime_mode: string;
					}>`
						SELECT runtime_mode FROM sessions
						WHERE id = ${sessionId}
					`;
					return { messages, turns, receipts, sessions };
				}),
			);

			expect(evidence.messages).toHaveLength(1);
			expect(evidence.messages[0]?.id).toBe(`${commandId}:message`);
			expect(
				JSON.parse(evidence.messages[0]?.content_json ?? "null"),
			).toMatchObject({ _tag: "user", text: "finish after the client closes" });
			expect(evidence.turns).toHaveLength(1);
			expect(
				JSON.parse(evidence.turns[0]?.payload_json ?? "null"),
			).toMatchObject({ turnId });
			expect(evidence.receipts).toEqual([{ stream_id: sessionId }]);
			expect(evidence.sessions).toEqual([{ runtime_mode: "full-access" }]);
		});
	});

	it("switches an existing conversation and hands its context to the new provider", async () => {
		await withRuntime(async (run) => {
			const sessionId = await run(
				Effect.gen(function* () {
					const service = yield* store;
					const created = yield* service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					});
					const id = created.initialSession.id;
					yield* service.importExternalMessages(id, [
						{ _tag: "user", text: "We chose SQLite for the queue." },
						{ _tag: "assistant", text: "Use a durable job ledger." },
					]);
					yield* service.setProvider(id, "codex", "gpt-5.4");
					yield* service.setProvider(id, "codex", "gpt-5.4");
					const timeline = yield* service.listMessages(id);
					expect(timeline.map((message) => message.content._tag)).toEqual([
						"user",
						"assistant",
						"model_switch",
					]);
					expect(timeline.at(-1)?.content).toEqual({
						_tag: "model_switch",
						fromProviderId: "claude",
						fromModel: "claude-opus-4-8",
						toProviderId: "codex",
						toModel: "gpt-5.4",
						context: "handoff",
					});
					const sql = yield* SqlClient.SqlClient;
					expect(
						yield* sql`SELECT id FROM sessions WHERE chat_id=${created.chat.id}`,
					).toHaveLength(1);
					expect(
						yield* sql`SELECT id FROM session_context_handoffs WHERE session_id=${id}`,
					).toHaveLength(1);
					return id;
				}),
			);
			await run(
				Effect.flatMap(store, (service) =>
					service.sendMessage(
						testCommandId("messages.send"),
						sessionId,
						"Implement the queue",
					),
				),
			);
			expect(providerSentTexts.at(-1)).toContain(
				"We chose SQLite for the queue.",
			);
			expect(providerSentTexts.at(-1)).toContain("Use a durable job ledger.");
			expect(providerSentTexts.at(-1)).not.toContain("model_switch");
			expect(providerSentTexts.at(-1)).not.toContain("Model switched");
			expect(providerSentTexts.at(-1)).toContain(
				"Current user request:\nImplement the queue",
			);
			expect(providerStartInputs.at(-1)?.providerId).toBe("codex");
			const messages = await run(
				Effect.flatMap(store, (service) => service.listMessages(sessionId)),
			);
			expect(messages.at(-1)?.content).toMatchObject({
				_tag: "user",
				text: "Implement the queue",
			});
			await expect(
				run(
					Effect.flatMap(store, (service) =>
						service.setProvider(sessionId, "claude", "claude-opus-4-8"),
					),
				),
			).rejects.toMatchObject({ _tag: "SessionConfigurationError" });
			expect(activeProviderSessions.has(sessionId)).toBe(true);
		});
	});

	for (const fallback of [false, true])
		it(`returns to the earlier native provider with ${fallback ? "explicit full-context fallback" : "only the missed context"}`, async () => {
			await withRuntime(async (run) => {
				const sessionId = await run(
					Effect.gen(function* () {
						const service = yield* store;
						const domain = yield* SessionDomain;
						const created = yield* service.createChat({
							projectId: PROJECT_ID,
							providerId: "codex",
							model: "gpt-5.4",
						});
						const id = created.initialSession.id;
						yield* service.importExternalMessages(id, [
							{ _tag: "user", text: "Original native context" },
						]);
						yield* domain.dispatch({
							commandId: "bind-original",
							streamId: id,
							command: {
								_tag: "BindProviderThread",
								nativeThreadId: "original-codex-thread",
								nativeHeadId: null,
								updatedAt: Date.now(),
							},
						});
						yield* service.setProvider(id, "claude", "claude-opus-4-8");
						yield* service.importExternalMessages(id, [
							{
								_tag: "assistant",
								text: "Context learned with the other provider",
							},
						]);
						yield* service.setProvider(id, "codex", "gpt-5.4");
						const returned = yield* service.getSession(id);
						expect(returned.providerThread?.nativeThreadRef.nativeId).toBe(
							"original-codex-thread",
						);
						return id;
					}),
				);
				providerNativeResumeFallback = fallback;
				await run(
					Effect.flatMap(store, (service) =>
						service.sendMessage(
							testCommandId("return"),
							sessionId,
							"Continue after returning",
						),
					),
				);
				expect(providerStartCursors.at(-1)).toBe("original-codex-thread");
				const sent = providerSentTexts.at(-1)!;
				expect(
					sent.match(/Context learned with the other provider/g),
				).toHaveLength(1);
				expect(sent.match(/Continue after returning/g)).toHaveLength(1);
				if (fallback)
					expect(sent.match(/Original native context/g)).toHaveLength(1);
				else expect(sent).not.toContain("Original native context");
				const rows = await run(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						return yield* sql<{
							fallback_at: number | null;
						}>`SELECT fallback_at FROM session_context_handoffs WHERE session_id=${sessionId} AND active=1`;
					}),
				);
				expect(rows[0]?.fallback_at !== null).toBe(fallback);
			});
		});

	it("rolls back a provider switch when its context cannot be persisted", async () => {
		await withRuntime(async (run) => {
			const sessionId = await run(
				Effect.gen(function* () {
					const service = yield* store;
					const created = yield* service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					});
					const id = created.initialSession.id;
					yield* service.importExternalMessages(id, [
						{ _tag: "user", text: "Important context" },
					]);
					const sql = yield* SqlClient.SqlClient;
					yield* sql`CREATE TRIGGER reject_handoff BEFORE INSERT ON session_context_handoffs BEGIN SELECT RAISE(ABORT, 'handoff unavailable'); END`;
					return id;
				}),
			);
			await expect(
				run(
					Effect.flatMap(store, (service) =>
						service.setProvider(sessionId, "codex", "gpt-5.4"),
					),
				),
			).rejects.toBeDefined();
			await run(
				Effect.gen(function* () {
					const service = yield* store;
					expect((yield* service.getSession(sessionId)).providerId).toBe(
						"claude",
					);
					const sql = yield* SqlClient.SqlClient;
					expect(
						yield* sql`SELECT id FROM session_context_handoffs`,
					).toHaveLength(0);
					expect(
						yield* sql`SELECT sequence FROM events WHERE stream_id=${sessionId} AND type='SessionProviderSet'`,
					).toHaveLength(0);
					expect(
						(yield* service.listMessages(sessionId)).map(
							(message) => message.content._tag,
						),
					).toEqual(["user"]);
				}),
			);
		});
	});

	it("switches model metadata without stopping a dormant provider", async () => {
		await withRuntime(async (run) => {
			const created = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			await run(
				Effect.flatMap(store, (service) =>
					service.setModel(created.initialSession.id, "claude-sonnet-4-6"),
				),
			);
			const evidence = await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const events = yield* sql<{ readonly type: string }>`
            SELECT type FROM events
            WHERE stream_id = ${created.initialSession.id}
              AND type IN ('ProviderStopRequested', 'ProviderDetached')
            ORDER BY sequence
          `;
					const domain = yield* SessionDomain;
					const stops = (yield* domain.jobs.listBySession(
						created.initialSession.id,
					)).filter((job) => job.request._tag === "provider.stop");
					return { events, stops };
				}),
			);

			expect(evidence.events).toEqual([]);
			expect(evidence.stops).toEqual([]);
		});
	});

	it("releases an idle provider for an account switch but never a running turn", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			await run(
				Effect.flatMap(SessionDomain, (domain) =>
					domain.dispatch({
						commandId: "test:attach-account-switch-provider",
						streamId: initialSession.id,
						command: {
							_tag: "AttachProvider",
							providerId: "claude",
							attachedAt: Date.now(),
						},
					}),
				),
			);
			activeProviderSessions.add(initialSession.id);
			expect(
				await run(
					Effect.flatMap(store, (service) =>
						service.releaseProvider(initialSession.id),
					),
				),
			).toBe(true);
			expect(activeProviderSessions.has(initialSession.id)).toBe(false);

			await run(
				Effect.flatMap(SessionDomain, (domain) =>
					domain.dispatch({
						commandId: "test:release-running-turn",
						streamId: initialSession.id,
						command: {
							_tag: "SubmitTurn",
							turnId: AgentTurnId.make("turn_release_running"),
							messageId: MessageId.make("message_release_running"),
							role: "user",
							kind: "user",
							contentJson: JSON.stringify({ _tag: "user", text: "work" }),
							parentItemId: null,
							providerInputJson: JSON.stringify(
								new ComposerInput({
									text: "work",
									attachments: [],
									fileRefs: [],
									skillRefs: [],
								}),
							),
							createdAt: Date.now(),
						},
					}),
				),
			);
			const session = await run(
				Effect.flatMap(store, (service) =>
					service.getSession(initialSession.id),
				),
			);
			expect(["booting", "running"]).toContain(session.status);
			expect(
				await run(
					Effect.flatMap(store, (service) =>
						service.releaseProvider(initialSession.id),
					),
				),
			).toBe(false);
		});
	});

	it("archives chats through the durable archive reactor", async () => {
		await withRuntime(async (run) => {
			const created = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						worktreeId: TEST_WORKTREE_ID,
					}),
				),
			);
			const result = await run(
				Effect.flatMap(store, (service) =>
					service.archiveChat(created.chat.id),
				),
			);
			expect(result.checkpoint).toBeNull();
			expect(result.job?.status).toBe("queued");
			await expect
				.poll(async () =>
					run(
						Effect.flatMap(store, (service) =>
							service.getArchiveStatus(created.chat.id),
						),
					),
				)
				.toMatchObject({ status: "completed", phase: "completed" });
			const evidence = await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const events = yield* sql<{ readonly type: string }>`
            SELECT type FROM events
            WHERE stream_id = ${created.chat.id}
              AND type IN ('ChatArchiveRequested', 'ChatArchived')
            ORDER BY sequence
          `;
					const receipts = yield* sql<{ readonly effect_id: string }>`
            SELECT effect_id FROM reactor_effect_receipts
            WHERE effect_id LIKE 'reactor:chat-archive:%'
          `;
					const steps = yield* sql<{
						readonly step: string;
						readonly status: string;
						readonly detail_json: string | null;
					}>`
            SELECT step, status, detail_json FROM reactor_effect_steps
            WHERE step = 'worktree-checkpoint'
          `;
					return { events, receipts, steps };
				}),
			);

			expect(result.chat.archivedAt).not.toBeNull();
			expect(evidence.events.map(({ type }) => type)).toEqual([
				"ChatArchiveRequested",
				"ChatArchived",
			]);
			expect(evidence.receipts).toHaveLength(1);
			expect(evidence.steps).toHaveLength(1);
			expect(evidence.steps[0]).toMatchObject({
				step: "worktree-checkpoint",
				status: "completed",
				detail_json: expect.stringContaining("checkpoint-sha"),
			});
		});
	});

	it("archives a chat without a worktree without scheduling Git cleanup", async () => {
		await withRuntime(async (run) => {
			const created = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const result = await run(
				Effect.flatMap(store, (service) =>
					service.archiveChat(created.chat.id),
				),
			);
			expect(result.chat.archivedAt).not.toBeNull();
			expect(result.job?.status).toBe("completed");
			expect(archiveWorktreeStarts).toBe(0);
		});
	});

	it("completes archive cleanup when the recorded worktree directory is missing", async () => {
		await withRuntime(async (run) => {
			const created = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						worktreeId: TEST_WORKTREE_ID,
					}),
				),
			);
			rmSync(testWorktree.path, { recursive: true, force: true });

			const result = await run(
				Effect.flatMap(store, (service) =>
					service.archiveChat(created.chat.id),
				),
			);

			expect(result.chat.archivedAt).not.toBeNull();
			await expect
				.poll(() =>
					run(
						Effect.flatMap(store, (service) =>
							service.getArchiveStatus(created.chat.id),
						),
					),
				)
				.toMatchObject({
					status: "completed",
					phase: "directory-missing",
					error: null,
				});

			await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
						UPDATE chat_archive_jobs
						SET status = 'failed', phase = 'failed', error = 'git is not installed'
						WHERE chat_id = ${created.chat.id}
					`;
				}),
			);
			await expect(
				run(
					Effect.flatMap(store, (service) =>
						service.listArchiveJobs(PROJECT_ID),
					),
				),
			).resolves.toEqual([
				expect.objectContaining({
					status: "failed",
					phase: "failed",
					error: "git is not installed",
				}),
			]);
			await expect(
				run(
					Effect.flatMap(store, (service) =>
						service.getArchiveStatus(created.chat.id),
					),
				),
			).resolves.toMatchObject({
				status: "failed",
				phase: "failed",
				error: "git is not installed",
			});
		});
	});

	it("completes archive cleanup without deleting when Git is unavailable", async () => {
		await withRuntime(async (run) => {
			archiveWorktreeFailure = "git-missing";
			const created = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						worktreeId: TEST_WORKTREE_ID,
					}),
				),
			);

			await run(
				Effect.flatMap(store, (service) =>
					service.archiveChat(created.chat.id),
				),
			);

			await expect
				.poll(() =>
					run(
						Effect.flatMap(store, (service) =>
							service.getArchiveStatus(created.chat.id),
						),
					),
				)
				.toMatchObject({
					status: "completed",
					phase: "retained-no-git",
					error: null,
				});
			expect(archivedWorktreeIds.has(TEST_WORKTREE_ID)).toBe(false);
		});
	});

	it("returns before worktree cleanup and force archive preserves the checkout", async () => {
		await withRuntime(async (run) => {
			const barrier = deferred<void>();
			archiveWorktreeBarrier = barrier.promise;
			const created = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						worktreeId: TEST_WORKTREE_ID,
					}),
				),
			);
			const accepted = await run(
				Effect.flatMap(store, (service) =>
					service.archiveChat(created.chat.id),
				),
			);
			expect(accepted.chat.archivedAt).not.toBeNull();
			expect(accepted.job?.status).toBe("queued");
			await expect.poll(() => archiveWorktreeStarts).toBe(1);
			const forcePromise = run(
				Effect.flatMap(store, (service) =>
					service.archiveChat(created.chat.id, true),
				),
			);
			await expect
				.poll(() =>
					run(
						Effect.flatMap(store, (service) =>
							service.getArchiveStatus(created.chat.id),
						),
					),
				)
				.toMatchObject({ status: "cancelled", phase: "force-requested" });
			expect(archivedWorktreeIds.has(TEST_WORKTREE_ID)).toBe(false);
			barrier.resolve();
			const forced = await forcePromise;
			expect(forced.job?.status).toBe("forced");
			expect(archivedWorktreeIds.has(TEST_WORKTREE_ID)).toBe(false);
		});
	});

	it("restores a checkpointed checkout before completing a late force request", async () => {
		await withRuntime(async (run) => {
			const created = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						worktreeId: TEST_WORKTREE_ID,
					}),
				),
			);
			await run(
				Effect.flatMap(store, (service) =>
					service.archiveChat(created.chat.id),
				),
			);
			await expect
				.poll(() => archivedWorktreeIds.has(TEST_WORKTREE_ID))
				.toBe(true);

			const forced = await run(
				Effect.flatMap(store, (service) =>
					service.archiveChat(created.chat.id, true),
				),
			);

			expect(forced.job?.status).toBe("forced");
			expect(archivedWorktreeIds.has(TEST_WORKTREE_ID)).toBe(false);
			expect(restoredWorktreeCount).toBe(1);
		});
	});

	it("runs cleanup for multiple chats concurrently", async () => {
		await withRuntime(async (run) => {
			const barrier = deferred<void>();
			archiveWorktreeBarrier = barrier.promise;
			const secondWorktreeId = "wt-created-1" as WorktreeId;
			const secondWorktreePath = join(dirname(testWorktree.path), "created-1");
			mkdirSync(secondWorktreePath, { recursive: true });
			createdWorktrees.set(
				secondWorktreeId,
				Worktree.make({
					...testWorktree,
					id: secondWorktreeId,
					path: secondWorktreePath,
					name: "created-1",
					branch: "created-1",
				}),
			);
			const makeChat = (worktreeId: WorktreeId) =>
				run(
					Effect.flatMap(store, (service) =>
						service.createChat({
							projectId: PROJECT_ID,
							providerId: "claude",
							model: "claude-opus-4-8",
							worktreeId,
						}),
					),
				);
			const first = await makeChat(TEST_WORKTREE_ID);
			const second = await makeChat(secondWorktreeId);
			const accepted = await Promise.all([
				run(
					Effect.flatMap(store, (service) =>
						service.archiveChat(first.chat.id),
					),
				),
				run(
					Effect.flatMap(store, (service) =>
						service.archiveChat(second.chat.id),
					),
				),
			]);
			expect(accepted.map((result) => result.job?.status)).toEqual([
				"queued",
				"queued",
			]);
			const snapshotIds = await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const rows = yield* sql<{ readonly snapshot_json: string }>`
						SELECT snapshot_json FROM chat_archive_jobs ORDER BY chat_id
					`;
					return rows.map(
						(row) => (JSON.parse(row.snapshot_json) as { id: string }).id,
					);
				}),
			);
			expect(new Set(snapshotIds)).toEqual(
				new Set([TEST_WORKTREE_ID, secondWorktreeId]),
			);
			try {
				await expect.poll(() => archiveWorktreeStarts).toBe(2);
			} finally {
				barrier.resolve();
			}
		});
	});

	it("retains a shared worktree until every referencing chat is archived", async () => {
		await withRuntime(async (run) => {
			const makeSharedChat = () =>
				run(
					Effect.flatMap(store, (service) =>
						service.createChat({
							projectId: PROJECT_ID,
							providerId: "claude",
							model: "claude-opus-4-8",
							worktreeId: TEST_WORKTREE_ID,
						}),
					),
				);
			const first = await makeSharedChat();
			const second = await makeSharedChat();

			await run(
				Effect.flatMap(store, (service) => service.archiveChat(first.chat.id)),
			);
			await expect
				.poll(() =>
					run(
						Effect.flatMap(store, (service) =>
							service.getArchiveStatus(first.chat.id),
						),
					),
				)
				.toMatchObject({ status: "completed", phase: "retained-shared" });
			expect(archiveWorktreeStarts).toBe(0);

			const removalBarrier = deferred<void>();
			archiveWorktreeBarrier = removalBarrier.promise;
			await run(
				Effect.flatMap(store, (service) => service.archiveChat(second.chat.id)),
			);
			await expect.poll(() => archiveWorktreeStarts).toBe(1);
			await expect(makeSharedChat()).rejects.toThrow();
			removalBarrier.resolve();
			await expect
				.poll(() => archivedWorktreeIds.has(TEST_WORKTREE_ID))
				.toBe(true);
		});
	});

	it("restores the archived worktree without replacing other live chats", async () => {
		await withRuntime(async (run) => {
			const other = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						title: "Existing main chat",
						initialPrompt: "Keep the main chat history",
					}),
				),
			);
			const archived = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						title: "Worktree chat",
						worktreeId: TEST_WORKTREE_ID,
						initialPrompt: "Keep the worktree chat history",
					}),
				),
			);

			await run(
				Effect.flatMap(store, (service) =>
					service.archiveChat(archived.chat.id),
				),
			);
			await expect
				.poll(async () =>
					run(
						Effect.flatMap(store, (service) =>
							service.getArchiveStatus(archived.chat.id),
						),
					),
				)
				.toMatchObject({ status: "completed" });

			await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
            UPDATE sessions SET worktree_id = NULL
            WHERE id = ${archived.initialSession.id}
          `;
				}),
			);
			const restored = await run(
				Effect.flatMap(store, (service) =>
					service.unarchiveChat(archived.chat.id),
				),
			);
			const liveChats = await run(
				Effect.flatMap(store, (service) =>
					service.listChats(PROJECT_ID, false),
				),
			);
			const liveSessions = await run(
				Effect.flatMap(store, (service) =>
					service.listSessions(PROJECT_ID, false),
				),
			);
			const otherMessages = await run(
				Effect.flatMap(store, (service) =>
					service.listMessages(other.initialSession.id),
				),
			);
			const restoredMessages = await run(
				Effect.flatMap(store, (service) =>
					service.listMessages(archived.initialSession.id),
				),
			);

			expect(restoredWorktreeCount).toBe(1);
			expect(restored.worktree?.id).toBe(TEST_WORKTREE_ID);
			expect(restored.chat.worktreeId).toBe(TEST_WORKTREE_ID);
			expect(restored.sessions.map((session) => session.worktreeId)).toEqual([
				TEST_WORKTREE_ID,
			]);
			expect(liveChats.map((chat) => chat.id)).toEqual(
				expect.arrayContaining([other.chat.id, archived.chat.id]),
			);
			expect(liveSessions.map((session) => session.id)).toEqual(
				expect.arrayContaining([
					other.initialSession.id,
					archived.initialSession.id,
				]),
			);
			expect(otherMessages).toHaveLength(1);
			expect(restoredMessages).toHaveLength(1);
		});
	});

	it("restores from the archive job when the chat snapshot projection is missing", async () => {
		await withRuntime(async (run) => {
			const archived = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						worktreeId: TEST_WORKTREE_ID,
					}),
				),
			);
			await run(
				Effect.flatMap(store, (service) =>
					service.archiveChat(archived.chat.id),
				),
			);
			await expect
				.poll(() =>
					run(
						Effect.flatMap(store, (service) =>
							service.getArchiveStatus(archived.chat.id),
						),
					),
				)
				.toMatchObject({ status: "completed" });
			await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
						UPDATE chats SET archived_worktree_json = NULL
						WHERE id = ${archived.chat.id}
					`;
				}),
			);

			const restorable = await run(
				Effect.flatMap(store, (service) =>
					service.getChatDirectoryStatus(archived.chat.id),
				),
			);
			const restored = await run(
				Effect.flatMap(store, (service) =>
					service.unarchiveChat(archived.chat.id),
				),
			);

			expect(restorable).toEqual({ _tag: "available" });
			expect(restored.worktree?.id).toBe(TEST_WORKTREE_ID);
			expect(restored.chat.worktreeId).toBe(TEST_WORKTREE_ID);
			expect(restored.directoryStatus).toEqual({ _tag: "available" });
		});
	});

	it("keeps a chat archived when restore fails and allows retry", async () => {
		await withRuntime(async (run) => {
			const archived = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						worktreeId: TEST_WORKTREE_ID,
					}),
				),
			);
			await run(
				Effect.flatMap(store, (service) =>
					service.archiveChat(archived.chat.id),
				),
			);
			await expect
				.poll(() => archivedWorktreeIds.has(TEST_WORKTREE_ID))
				.toBe(true);

			restoreWorktreeFailure = true;
			await expect(
				run(
					Effect.flatMap(store, (service) =>
						service.unarchiveChat(archived.chat.id),
					),
				),
			).rejects.toMatchObject({
				_tag: "ChatArchiveWorktreeError",
				reason: "simulated restore failure",
			});
			await expect(
				run(
					Effect.flatMap(store, (service) => service.getChat(archived.chat.id)),
				),
			).resolves.toMatchObject({ archivedAt: expect.any(Date) });

			restoreWorktreeFailure = false;
			await expect(
				run(
					Effect.flatMap(store, (service) =>
						service.unarchiveChat(archived.chat.id),
					),
				),
			).resolves.toMatchObject({
				chat: { archivedAt: null },
				worktree: { id: TEST_WORKTREE_ID },
			});
		});
	});

	it("returns the archived chat with only its original sessions for preview", async () => {
		await withRuntime(async (run) => {
			const created = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						title: "Preview me",
					}),
				),
			);
			const secondSession = await run(
				Effect.flatMap(store, (service) =>
					service.createSession({
						chatId: created.chat.id,
						providerId: "claude",
						model: "claude-opus-4-8",
						title: "Second tab",
					}),
				),
			);
			const other = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						title: "Other chat",
					}),
				),
			);
			const liveAttempt = await run(
				Effect.result(
					Effect.flatMap(store, (service) =>
						service.getArchivePreview(created.chat.id),
					),
				),
			);
			expect(liveAttempt).toMatchObject({
				_tag: "Failure",
				failure: { _tag: "ChatNotArchivedError", chatId: created.chat.id },
			});

			await run(
				Effect.flatMap(store, (service) =>
					service.archiveChat(created.chat.id),
				),
			);
			const preview = await run(
				Effect.flatMap(store, (service) =>
					service.getArchivePreview(created.chat.id),
				),
			);

			expect(preview.chat.id).toBe(created.chat.id);
			expect(preview.chat.title).toBe("Preview me");
			expect(preview.chat.archivedAt).not.toBeNull();
			expect(preview.sessions.map((session) => session.id)).toEqual([
				created.initialSession.id,
				secondSession.id,
			]);
			expect(preview.sessions).not.toContainEqual(
				expect.objectContaining({ id: other.initialSession.id }),
			);
		});
	});

	it("deletes chats through the durable deletion reactor", async () => {
		await withRuntime(async (run) => {
			const created = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			await run(
				Effect.flatMap(store, (service) => service.deleteChat(created.chat.id)),
			);
			const evidence = await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const events = yield* sql<{ readonly type: string }>`
            SELECT type FROM events
            WHERE stream_id = ${created.chat.id}
              AND type IN ('ChatDeleteRequested', 'ChatDeleted')
            ORDER BY sequence
          `;
					const receipts = yield* sql<{ readonly command_id: string }>`
            SELECT command_id FROM command_receipts
            WHERE command_id LIKE 'reactor:chat-delete:%:delete'
          `;
					const chats = yield* sql<{ readonly id: string }>`
            SELECT id FROM chats WHERE id = ${created.chat.id}
          `;
					return { events, receipts, chats };
				}),
			);

			expect(evidence.events.map(({ type }) => type)).toEqual([
				"ChatDeleteRequested",
				"ChatDeleted",
			]);
			expect(evidence.receipts).toHaveLength(1);
			expect(evidence.chats).toEqual([]);
		});
	});

	it("createChat persists a chat, an initial session, and the user message", async () => {
		await withRuntime(async (run) => {
			const result = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "fix the bug",
					}),
				),
			);

			expect(result.chat.projectId).toBe(PROJECT_ID);
			expect(result.initialSession.providerId).toBe("claude");
			expect(result.initialSession.chatId).toBe(result.chat.id);

			expect(result.initialSession.status).toBe("booting");
			expect(result.initialMessage?.role).toBe("user");
			expect(result.initialMessage?.content).toMatchObject({
				_tag: "user",
				text: "fix the bug",
			});
			expect(providerStartInputs.at(-1)?.cwdOverride).toBeUndefined();
		});
	});

	it("createChat acknowledges the durable initial turn before provider startup completes", async () => {
		await withRuntime(async (run) => {
			const providerGate = deferred<void>();
			providerStartBarrier = providerGate.promise;
			const creation = run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "start after acknowledgement",
					}),
				),
			);
			const result = await Promise.race([
				creation.then(() => "acknowledged" as const),
				new Promise<"blocked">((resolve) =>
					setTimeout(() => resolve("blocked"), 100),
				),
			]);
			providerGate.resolve();
			await creation;

			expect(result).toBe("acknowledged");
		});
	});

	it("createChat accepts client ids and returns before background provider startup", async () => {
		await withRuntime(async (run) => {
			const chatId = ChatId.make("chat_client_optimistic");
			const sessionId = SessionId.make("s_client_optimistic");
			const result = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						chatId,
						initialSessionId: sessionId,
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						background: true,
					}),
				),
			);

			expect(result.chat.id).toBe(chatId);
			expect(result.initialSession.id).toBe(sessionId);
			expect(result.initialSession.status).toBe("idle");
			expect(result.initialMessage).toBeNull();
			const messages = await run(
				Effect.flatMap(store, (service) => service.listMessages(sessionId)),
			);
			expect(messages).toEqual([]);
		});
	});

	it("keeps a durable initial turn paused until workspace startup releases it", async () => {
		await withRuntime(async (run) => {
			const sessionId = SessionId.make("s_paused_workspace_startup");
			const turnId = AgentTurnId.make("turn_paused_workspace_startup");
			const result = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						chatId: ChatId.make("chat_paused_workspace_startup"),
						initialSessionId: sessionId,
						initialTurnId: turnId,
						initialMessageId: MessageId.make(
							"message_paused_workspace_startup",
						),
						commandId: "chat-create:paused:bootstrap",
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "wait for setup",
						queuePaused: true,
						background: true,
					}),
				),
			);

			expect(result.initialMessage?.content).toMatchObject({
				_tag: "user",
				text: "wait for setup",
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(
				providerStartInputs.some((input) => input.sessionId === sessionId),
			).toBe(false);

			await run(
				Effect.flatMap(store, (service) =>
					service.releaseInitialTurn(
						"chat-create:paused:release",
						sessionId,
						turnId,
						JSON.stringify({
							text: "wait for setup",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
							annotations: [],
						}),
					),
				),
			);
			await expect
				.poll(() =>
					providerStartInputs.some((input) => input.sessionId === sessionId),
				)
				.toBe(true);
		});
	});

	it("createChat stamps origin without changing the provider prompt for spawned chats", async () => {
		await withRuntime(async (run) => {
			const result = await run(
				Effect.gen(function* () {
					const s = yield* store;
					const parent = yield* s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					});
					const child = yield* s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "do the spawned task",
						originSessionId: parent.initialSession.id,
					});
					return { parent, child };
				}),
			);

			expect(result.child.initialMessage?.content).toMatchObject({
				_tag: "user",
				text: "do the spawned task",
				origin: {
					chatId: result.parent.chat.id,
					sessionId: result.parent.initialSession.id,
					providerId: "claude",
				},
			});
			await expect
				.poll(() =>
					providerStartInputs.find(
						(input) => input.sessionId === result.child.initialSession.id,
					),
				)
				.toBeDefined();
			await expect
				.poll(() => providerSentTexts)
				.toContain("do the spawned task");
		});
	});

	it("persists Slack attribution while the agent receives the full prompt", async () => {
		await withRuntime(async (run) => {
			const created = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const source = {
				_tag: "slack",
				text: "Why are webhook deliveries failing?",
				author: "Ada Lovelace",
				channel: "eng-alerts",
			} as const;
			const prompt = `Request from Slack (thread 1.0):\n${source.text}`;
			await run(
				Effect.flatMap(store, (service) =>
					service.sendMessageWithInput({
						commandId: "slack-attributed-prompt",
						sessionId: created.initialSession.id,
						text: prompt,
						source,
					}),
				),
			);
			const messages = await run(
				Effect.flatMap(store, (service) =>
					service.listMessages(created.initialSession.id),
				),
			);
			expect(
				messages.find((message) => message.content._tag === "user")?.content,
			).toMatchObject({ _tag: "user", text: prompt, source });
			await expect.poll(() => providerSentTexts).toContain(prompt);
		});
	});

	for (const mode of ["queue", "steer", "restart"] as const)
		it(`managed orchestration ${mode} preserves durable delivery and task cancellation`, async () => {
			await withRuntime(async (run) => {
				const parent = await run(
					Effect.flatMap(store, (s) =>
						s.createChat({
							projectId: PROJECT_ID,
							providerId: "claude",
							model: "claude-opus-4-8",
							initialPrompt: "Delegate review",
						}),
					),
				);
				const tools = providerStartOrchestrationTools.at(-1)?.deps;
				if (!tools?.delegateTask || !tools.taskCancel || !tools.taskStatus)
					throw new Error("Missing managed tools");
				const input = { task: "Review parser", clientRequestId: "review" };
				const [created, concurrent] = await Promise.all([
					tools.delegateTask(input),
					tools.delegateTask(input),
				]);
				expect(
					concurrent.ok && created.ok && concurrent.taskId === created.taskId,
				).toBe(true);
				expect(created.ok).toBe(true);
				if (!created.ok) return;
				expect(
					await run(
						Effect.flatMap(store, (s) =>
							s.getSession(SessionId.make(created.sessionId)),
						),
					),
				).toMatchObject({ parentSessionId: parent.initialSession.id });
				expect(
					await run(
						Effect.flatMap(store, (s) => s.listSessions(PROJECT_ID, false)),
					),
				).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							id: created.sessionId,
							parentSessionId: parent.initialSession.id,
						}),
					]),
				);

				const retry = await tools.delegateTask(input);
				expect(retry.ok && retry.taskId).toBe(created.taskId);
				await expect
					.poll(() =>
						providerStartInputs.some(
							(input) => input.sessionId === created.sessionId,
						),
					)
					.toBe(true);
				const sent = await tools.sendToThread({
					sessionId: created.sessionId,
					text: "Check cancellation",
					commandId: `send-${mode}`,
					mode,
				});
				expect(sent).toMatchObject({ ok: true, queued: true });
				expect(
					await tools.sendToThread({
						sessionId: created.sessionId,
						text: "Check cancellation",
						commandId: `send-${mode}`,
						mode,
					}),
				).toMatchObject({ ok: true });
				await run(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						expect(
							(yield* sql`SELECT 1 FROM events WHERE stream_id=${created.sessionId} AND type='SessionCreated'`)
								.length,
						).toBe(1);
						yield* sql`INSERT INTO scheduled_tasks(id,session_id,client_request_id,title,prompt,schedule_json,created_at) VALUES('child-schedule',${created.sessionId},'schedule','Follow-up','Do work','{"kind":"webhook"}',1)`;
						yield* sql`INSERT INTO scheduled_task_deliveries(task_id,event_id,command_id,prompt,created_at) VALUES('child-schedule','hook:1','schedule-command','Do work',1)`;

						const rows =
							yield* sql`SELECT 1 FROM events WHERE stream_id=${created.sessionId} AND type='QueuedTurnEnqueued'`;
						expect(rows.length).toBe(1);
						if (mode !== "queue")
							expect(
								(yield* sql`SELECT 1 FROM events WHERE stream_id=${created.sessionId} AND type='SuccessorTurnScheduled'`)
									.length,
							).toBe(1);
					}),
				);
				expect(
					await tools.taskStatus({ taskId: created.taskId }),
				).toMatchObject({ ok: true });
				expect(
					await tools.taskCancel({ taskId: created.taskId }),
				).toMatchObject({ ok: true, workState: "cancelled" });
				await run(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						expect(
							(yield* sql<{
								enabled: number;
							}>`SELECT enabled FROM scheduled_tasks WHERE id='child-schedule'`)[0]
								?.enabled,
						).toBe(0);
						expect(
							(yield* sql`SELECT 1 FROM scheduled_task_deliveries WHERE task_id='child-schedule'`)
								.length,
						).toBe(0);
					}),
				);

				expect(
					await tools.sendToThread({
						sessionId: created.sessionId,
						text: "Must not restart",
					}),
				).toMatchObject({ ok: false });
				expect(parent.initialSession.id).not.toBe(created.sessionId);
			});
		});

	it.each([
		"current",
		"residency-revoked",
		"turn-settled",
	] as const)("emit_ui fences %s ownership at persistence", async (mode) => {
		await withRuntime(async (run) => {
			const parent = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "render a result",
					}),
				),
			);
			await expect
				.poll(() => providerStartOrchestrationTools.at(-1))
				.toBeDefined();
			const tools = providerStartOrchestrationTools.at(-1);
			if (!tools) throw new Error("Provider tools were not created");
			let intercepted = false;
			beforeProviderWrite = (domain, input) =>
				Effect.gen(function* () {
					if (
						input.command._tag !== "PersistMessage" ||
						input.command.kind !== "ui_spec"
					)
						return;
					expect(input.expectedProviderSessionId).toBeDefined();
					expect(input.expectedAttempt).toBeDefined();
					if (!input.expectedAttempt)
						return yield* Effect.die("Missing attempt fence");
					intercepted = true;
					if (mode === "current") return;
					yield* domain
						.dispatch({
							commandId: `revoke-ui-${mode}`,
							streamId: input.streamId,
							command:
								mode === "residency-revoked"
									? { _tag: "RequestProviderStop", requestedAt: Date.now() }
									: {
											_tag: "SettleTurn",
											turnId: input.expectedAttempt.turnId,
											outcome: "completed",
											settledAt: Date.now(),
										},
						})
						.pipe(Effect.orDie);
				});
			const spec = 'root = Text("Result")';
			const result = await tools.deps.emitUi({ spec });
			expect(intercepted).toBe(true);
			expect(result.ok).toBe(mode === "current");
			const messages = await run(
				Effect.flatMap(store, (service) =>
					service.listMessages(parent.initialSession.id),
				),
			);
			expect(
				messages.filter((message) => message.content._tag === "ui_spec"),
			).toHaveLength(mode === "current" ? 1 : 0);
		});
	});

	it("create_session without chatId opens a new tab in the caller's chat", async () => {
		await withRuntime(async (run) => {
			const parent = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						worktreeId: TEST_WORKTREE_ID,
						initialPrompt: "open orchestration tools",
					}),
				),
			);
			expect(parent.initialSession.worktreeId).toBe(TEST_WORKTREE_ID);
			const tools = providerStartOrchestrationTools.at(-1);
			expect(tools).not.toBeNull();
			expect(tools).not.toBeUndefined();

			const created = await tools!.deps.createSession({
				task: "Open another tab here",
			});
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			expect(created.chatId).toBe(parent.chat.id);
			expect(created.sessionId).not.toBe(parent.initialSession.id);
			expect(created.worktreeId).toBe(TEST_WORKTREE_ID);

			const child = await run(
				Effect.flatMap(store, (s) =>
					s.getSession(created.sessionId as SessionId),
				),
			);
			expect(child.worktreeId).toBe(TEST_WORKTREE_ID);
			expect(child.chatId).toBe(parent.chat.id);
			const replayed = await run(
				Effect.flatMap(store, (s) =>
					s.streamChatChanges(PROJECT_ID).pipe(
						Stream.flatMap((change) =>
							change._tag === "snapshot"
								? Stream.fromIterable(change.chats)
								: Stream.succeed(change.chat),
						),
						Stream.filter((chat) => chat.id === parent.chat.id),
						Stream.take(1),
						Stream.runCollect,
						Effect.timeout(1_000),
					),
				),
			);
			expect(replayed.map((chat) => chat.activeSessionId as string)).toEqual([
				created.sessionId,
			]);
		});
	});

	it("create_thread creates a new worktree and uses the target provider default model", async () => {
		await withRuntime(async (run) => {
			const parent = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						worktreeId: TEST_WORKTREE_ID,
						initialPrompt: "open orchestration tools",
					}),
				),
			);
			const tools = providerStartOrchestrationTools.at(-1);
			expect(tools).not.toBeNull();
			expect(tools).not.toBeUndefined();

			const models = await tools!.deps.listModels({ providerId: "codex" });
			expect(models.ok).toBe(true);
			if (!models.ok) return;
			expect(models.providers).toHaveLength(1);
			expect(models.providers[0]?.providerId).toBe("codex");
			expect(models.providers[0]?.models.map((m) => m.id)).toContain(
				defaultModelFor(BUNDLED_MODEL_CATALOG, "codex"),
			);

			const created = await tools!.deps.createThread({
				title: "Codex greeting",
				task: "Say hi!",
				providerId: "codex",
			});
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			expect(created.worktreeId).not.toBeNull();
			expect(created.worktreeId).not.toBe(TEST_WORKTREE_ID);
			expect(created.path).toContain("/created-");
			expect(created.branch).toContain("created-");

			const child = await run(
				Effect.flatMap(store, (s) =>
					s.getSession(created.sessionId as SessionId),
				),
			);
			expect(child.providerId).toBe("codex");
			expect(child.model).toBe(defaultModelFor(BUNDLED_MODEL_CATALOG, "codex"));
			expect(child.worktreeId).toBe(created.worktreeId as WorktreeId);
			expect(parent.initialSession.worktreeId).toBe(TEST_WORKTREE_ID);
			await expect
				.poll(() =>
					providerStartInputs.find(
						(input) => input.sessionId === (created.sessionId as SessionId),
					),
				)
				.toMatchObject({
					providerId: "codex",
					model: defaultModelFor(BUNDLED_MODEL_CATALOG, "codex"),
				});
			const replayed = await run(
				Effect.flatMap(store, (s) =>
					s.streamChatChanges(PROJECT_ID).pipe(
						Stream.flatMap((change) =>
							change._tag === "snapshot"
								? Stream.fromIterable(change.chats)
								: Stream.succeed(change.chat),
						),
						Stream.filter((chat) => (chat.id as string) === created.chatId),
						Stream.take(1),
						Stream.runCollect,
						Effect.timeout(1_000),
					),
				),
			);
			expect(replayed.map((chat) => chat.activeSessionId as string)).toEqual([
				created.sessionId,
			]);
		});
	});

	it("createChat publishes the new chat to live chat streams", async () => {
		await withRuntime(async (run) => {
			const result = await run(
				Effect.gen(function* () {
					const s = yield* store;
					const streamFiber = yield* s.streamChatChanges(PROJECT_ID).pipe(
						Stream.flatMap((change) =>
							change._tag === "snapshot"
								? Stream.fromIterable(change.chats)
								: Stream.succeed(change.chat),
						),
						Stream.take(1),
						Stream.runCollect,
						Effect.forkChild,
					);
					yield* Effect.sleep("10 millis");
					const created = yield* s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "spawn a sibling thread",
					});
					const emitted = yield* Fiber.join(streamFiber);
					return { created, emitted };
				}),
			);

			expect(result.emitted.map((chat) => chat.id)).toEqual([
				result.created.chat.id,
			]);
		});
	});

	it("reconciles chats persisted outside the in-memory change hub", async () => {
		await withRuntime(async (run, dbPath) => {
			const externalChatId = ChatId.make("chat-external-runtime");
			const observed = await run(
				Effect.gen(function* () {
					const s = yield* store;
					yield* s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					});
					const streamFiber = yield* s.streamChatChanges(PROJECT_ID).pipe(
						Stream.filter(
							(change) =>
								change._tag === "snapshot" &&
								change.chats.some((chat) => chat.id === externalChatId),
						),
						Stream.take(1),
						Stream.runCollect,
						Effect.timeout(1_500),
						Effect.forkChild,
					);
					yield* Effect.sleep("10 millis");
					const timestamp = new Date().toISOString();
					const externalRuntime = ManagedRuntime.make(
						sqliteLayer({ filename: dbPath }),
					);
					yield* Effect.tryPromise({
						try: () =>
							externalRuntime.runPromise(
								Effect.gen(function* () {
									const sql = yield* SqlClient.SqlClient;
									yield* sql`
										INSERT INTO chats (
											id, project_id, title, title_provenance, created_at, updated_at
										) VALUES (
											${externalChatId},
											${PROJECT_ID},
											${"External runtime chat"},
											${"manual"},
											${timestamp},
											${timestamp}
										)
									`;
								}),
							),
						catch: (cause) => cause,
					}).pipe(
						Effect.ensuring(
							Effect.promise(() => externalRuntime.dispose()).pipe(
								Effect.ignore,
							),
						),
					);
					return yield* Fiber.join(streamFiber);
				}),
			);

			expect(observed).toHaveLength(1);
		});
	});

	it("reconciles local chat commands without a precise live patch", async () => {
		await withRuntime(async (run) => {
			const observed = await run(
				Effect.gen(function* () {
					const s = yield* store;
					const created = yield* s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					});
					const streamFiber = yield* s.streamChatChanges(PROJECT_ID).pipe(
						Stream.filter(
							(change) =>
								change._tag === "snapshot" &&
								change.chats.some(
									(chat) =>
										chat.id === created.chat.id &&
										chat.worktreeId === TEST_WORKTREE_ID,
								),
						),
						Stream.take(1),
						Stream.runCollect,
						Effect.timeout(1_500),
						Effect.forkChild,
					);
					yield* Effect.sleep("10 millis");
					yield* s.setChatWorktree(created.chat.id, TEST_WORKTREE_ID);
					return yield* Fiber.join(streamFiber);
				}),
			);

			expect(observed).toHaveLength(1);
		});
	});

	it("advances the chat catalog cursor only for effective chat changes", async () => {
		await withRuntime(async (run) => {
			const revisions = await run(
				Effect.gen(function* () {
					const s = yield* store;
					const sql = yield* SqlClient.SqlClient;
					const created = yield* s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					});
					const readRevision = Effect.map(
						sql<{ readonly revision: number }>`
							SELECT revision FROM chat_catalog_revision WHERE id = 1
						`,
						(rows) => rows[0]?.revision ?? -1,
					);
					const afterCreate = yield* readRevision;
					yield* sql`
						UPDATE projects SET name = ${"Unrelated"} WHERE id = ${PROJECT_ID}
					`;
					const afterUnrelatedWrite = yield* readRevision;
					yield* sql`
						UPDATE chats SET title = title WHERE id = ${created.chat.id}
					`;
					const afterNoopChatWrite = yield* readRevision;
					yield* sql`
						UPDATE chats SET title = ${"Changed"} WHERE id = ${created.chat.id}
					`;
					const afterChatWrite = yield* readRevision;
					return {
						afterCreate,
						afterUnrelatedWrite,
						afterNoopChatWrite,
						afterChatWrite,
					};
				}),
			);

			expect(revisions.afterUnrelatedWrite).toBe(revisions.afterCreate);
			expect(revisions.afterNoopChatWrite).toBe(revisions.afterCreate);
			expect(revisions.afterChatWrite).toBe(revisions.afterCreate + 1);
		});
	});

	it("createSession publishes the updated active session to live chat streams", async () => {
		await withRuntime(async (run) => {
			const result = await run(
				Effect.gen(function* () {
					const s = yield* store;
					const created = yield* s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					});
					const streamFiber = yield* s.streamChatChanges(PROJECT_ID).pipe(
						Stream.flatMap((change) =>
							change._tag === "snapshot"
								? Stream.fromIterable(change.chats)
								: Stream.succeed(change.chat),
						),
						Stream.filter(
							(chat) =>
								chat.id === created.chat.id &&
								chat.activeSessionId !== created.initialSession.id,
						),
						Stream.take(1),
						Stream.runCollect,
						Effect.forkChild,
					);
					yield* Effect.sleep("10 millis");
					const session = yield* s.createSession({
						chatId: created.chat.id,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "open another tab",
						background: true,
					});
					const emitted = yield* Fiber.join(streamFiber);
					return { session, emitted };
				}),
			);

			expect(result.emitted.map((chat) => chat.id)).toEqual([
				result.session.chatId,
			]);
			expect(result.emitted.map((chat) => chat.activeSessionId)).toEqual([
				result.session.id,
			]);
		});
	});

	it("starts a worktree-backed chat session in the worktree cwd", async () => {
		await withRuntime(async (run) => {
			const result = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						worktreeId: TEST_WORKTREE_ID,
					}),
				),
			);

			expect(result.chat.worktreeId).toBe(TEST_WORKTREE_ID);
			expect(result.initialSession.worktreeId).toBe(TEST_WORKTREE_ID);
			expect(providerStartInputs).toEqual([]);
			await run(
				Effect.flatMap(store, (s) =>
					s.sendMessage(
						testCommandId("messages.send"),
						result.initialSession.id,
						"start in the worktree",
					),
				),
			);
			await expect.poll(() => providerStartInputs.length).toBe(1);
			expect(providerStartInputs.at(-1)?.cwdOverride).toBe(testWorktree.path);
		});
	});

	it("creates an external continued thread with a persisted resume cursor and no initial message", async () => {
		await withRuntime(async (run) => {
			const result = await run(
				Effect.flatMap(store, (s) =>
					s.continueExternalThread({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						title: "Existing Claude thread",
						providerThread: { nativeThreadId: "claude-session-123" },
					}),
				),
			);

			expect(result.chat.title).toBe("Existing Claude thread");
			expect(
				result.initialSession.providerThread?.nativeThreadRef.nativeId,
			).toBe("claude-session-123");
			expect(result.initialSession.providerThread?.provider).toBe("claude");
			expect(providerStartCursors).toEqual([]);
			await run(
				Effect.flatMap(store, (s) => s.resumeSession(result.initialSession.id)),
			);
			expect(providerStartCursors.at(-1)).toBe("claude-session-123");

			const messages = await run(
				Effect.flatMap(store, (s) => s.listMessages(result.initialSession.id)),
			);
			expect(messages).toEqual([]);
		});
	});

	it("inherits the chat worktree cwd when adding another session tab", async () => {
		await withRuntime(async (run) => {
			const result = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						worktreeId: TEST_WORKTREE_ID,
					}),
				),
			);
			expect(providerStartInputs).toEqual([]);

			const nextSession = await run(
				Effect.flatMap(store, (s) =>
					s.createSession({
						chatId: result.chat.id,
						providerId: "codex",
						model: "gpt-5-codex",
					}),
				),
			);

			expect(nextSession.worktreeId).toBe(TEST_WORKTREE_ID);
			expect(providerStartInputs).toEqual([]);
			await run(
				Effect.flatMap(store, (s) =>
					s.sendMessage(
						testCommandId("messages.send"),
						nextSession.id,
						"start the second tab",
					),
				),
			);
			await expect.poll(() => providerStartInputs.length).toBe(1);
			expect(providerStartInputs[0]?.cwdOverride).toBe(testWorktree.path);
		});
	});

	it("clears stale resume cursors when a chat worktree changes before the first message", async () => {
		await withRuntime(async (run) => {
			const result = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
            INSERT INTO session_provider_threads
              (id, session_id, provider, native_thread_id, native_head_id, status,
               first_turn_ordinal, last_turn_ordinal, created_at, updated_at)
            VALUES
              ('pt-main-cwd', ${result.initialSession.id}, 'claude', 'claude-main-cwd',
               NULL, 'idle', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
          `;
					yield* sql`
            UPDATE sessions SET active_provider_thread_id = 'pt-main-cwd'
            WHERE id = ${result.initialSession.id}
          `;
				}),
			);

			await run(
				Effect.flatMap(store, (s) =>
					s.setChatWorktree(result.chat.id, TEST_WORKTREE_ID),
				),
			);
			const updated = await run(
				Effect.flatMap(store, (s) => s.getSession(result.initialSession.id)),
			);

			expect(updated.worktreeId).toBe(TEST_WORKTREE_ID);
			expect(updated.providerThread).toBeNull();
		});
	});

	it("clears stale resume cursors when a session worktree changes before the first message", async () => {
		await withRuntime(async (run) => {
			const result = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
            INSERT INTO session_provider_threads
              (id, session_id, provider, native_thread_id, native_head_id, status,
               first_turn_ordinal, last_turn_ordinal, created_at, updated_at)
            VALUES
              ('pt-main-cwd', ${result.initialSession.id}, 'claude', 'claude-main-cwd',
               NULL, 'idle', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
          `;
					yield* sql`
            UPDATE sessions SET active_provider_thread_id = 'pt-main-cwd'
            WHERE id = ${result.initialSession.id}
          `;
				}),
			);

			await run(
				Effect.flatMap(store, (s) =>
					s.setWorktree(result.initialSession.id, TEST_WORKTREE_ID),
				),
			);
			const updated = await run(
				Effect.flatMap(store, (s) => s.getSession(result.initialSession.id)),
			);

			expect(updated.worktreeId).toBe(TEST_WORKTREE_ID);
			expect(updated.providerThread).toBeNull();
		});
	});

	it("listSessions and getSession read the persisted row back", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "grok",
						model: "grok-code",
					}),
				),
			);

			const listed = await run(
				Effect.flatMap(store, (s) => s.listSessions(PROJECT_ID, false)),
			);
			expect(listed.map((x) => x.id)).toContain(initialSession.id);

			const got = await run(
				Effect.flatMap(store, (s) => s.getSession(initialSession.id)),
			);
			expect(got.id).toBe(initialSession.id);
			expect(got.providerId).toBe("grok");
		});
	});

	it("getSession fails with SessionNotFoundError for an unknown id", async () => {
		await withRuntime(async (run) => {
			const exit = await run(
				Effect.flatMap(store, (s) =>
					s.getSession("does-not-exist" as SessionId),
				).pipe(Effect.result),
			);
			expect(exit._tag).toBe("Failure");
			if (exit._tag === "Failure") {
				expect((exit.failure as { _tag: string })._tag).toBe(
					"SessionNotFoundError",
				);
			}
		});
	});

	it("reports a stale plan decision without inventing a failed result", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "grok",
						model: "grok-code",
					}),
				),
			);
			const toolCallId = "plan_stale" as import("@zuse/contracts").AgentItemId;
			const result = await run(
				Effect.flatMap(store, (s) =>
					s
						.respondToPlan(
							initialSession.id,
							toolCallId,
							"cancelled",
							"Add error recovery",
						)
						.pipe(Effect.result),
				),
			);

			expect(result._tag).toBe("Failure");
			const messages = await run(
				Effect.flatMap(store, (s) => s.listMessages(initialSession.id)),
			);
			expect(result).toMatchObject({
				_tag: "Failure",
				failure: { _tag: "PlanResolutionError" },
			});
			expect(
				messages.some((message) => message.content._tag === "tool_result"),
			).toBe(false);
			expect(providerPlanResponses).toBe(0);
		});
	});

	it.each([
		"accepted",
		"replaced",
		"missing",
		"legacy",
	] as const)("handles %s plan response with original ownership and a stable receipt", async (mode) => {
		const toolCallId = AgentItemId.make("plan-owned");
		scriptedEvents = [
			{
				_tag: "ToolUse",
				itemId: toolCallId,
				tool: "ExitPlanMode",
				input: { plan: "Implement recovery" },
			},
		];
		providerPlanAvailable = mode !== "missing";
		try {
			await withRuntime(async (run) => {
				const { initialSession } = await run(
					Effect.flatMap(store, (service) =>
						service.createChat({
							projectId: PROJECT_ID,
							providerId: "grok",
							model: "grok-code",
							initialPrompt: "Plan recovery",
						}),
					),
				);
				const sessionId = initialSession.id;
				await expect
					.poll(() =>
						run(
							Effect.flatMap(store, (service) =>
								service.listMessages(sessionId),
							),
						).then((messages) =>
							messages.some((message) => message.content._tag === "tool_use"),
						),
					)
					.toBe(true);
				if (mode === "replaced")
					await run(
						Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient;
							yield* sql`UPDATE sessions SET provider_reservation_id = 'replacement' WHERE id = ${sessionId}`;
						}),
					);
				if (mode === "legacy")
					await run(
						Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient;
							yield* sql`UPDATE events SET payload_json = json_remove(payload_json,'$.inputOwner') WHERE stream_id = ${sessionId} AND type = 'MessagePersisted'`;
						}),
					);
				const respond = (outcome: "approved" | "cancelled") =>
					run(
						Effect.flatMap(store, (service) =>
							service.respondToPlan(
								sessionId,
								toolCallId,
								outcome,
								"Use recovery",
							),
						),
					);
				if (mode === "accepted") {
					await Promise.all([respond("approved"), respond("approved")]);
					await expect(respond("cancelled")).rejects.toMatchObject({
						_tag: "PlanResolutionError",
					});
					providerPlanAvailable = false;
					await run(
						Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient;
							yield* sql`UPDATE sessions SET provider_reservation_id = NULL WHERE id = ${sessionId}`;
						}),
					);
					await respond("approved");
					expect(providerPlanResponses).toBe(1);
					expect(providerPlanAcknowledgements).toBe(3);
					const rows = await run(
						Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient;
							return yield* sql<{
								kind: string;
								turn_id: string;
							}>`SELECT kind,turn_id FROM messages WHERE session_id = ${sessionId} AND kind IN ('tool_use','tool_result') ORDER BY sequence`;
						}),
					);
					expect(rows).toHaveLength(2);
					expect(rows[1]?.turn_id).toBe(rows[0]?.turn_id);
					expect(rows[0]?.turn_id).not.toBeNull();
				} else {
					await expect(respond("approved")).rejects.toMatchObject({
						_tag: "PlanResolutionError",
					});
					expect(providerPlanResponses).toBe(mode === "missing" ? 1 : 0);
					expect(providerPlanAcknowledgements).toBe(0);
					const messages = await run(
						Effect.flatMap(store, (service) => service.listMessages(sessionId)),
					);
					expect(
						messages.filter(
							(message) => message.content._tag === "tool_result",
						),
					).toEqual([]);
				}
			});
		} finally {
			scriptedEvents = [];
		}
	});

	it("rejects Pi permission changes without persisting them", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "pi",
						model: "auto",
					}),
				),
			);
			const runtimeResult = await run(
				Effect.flatMap(store, (s) =>
					s.setRuntimeMode(initialSession.id, "full-access", "pi-runtime"),
				).pipe(Effect.result),
			);
			const permissionResult = await run(
				Effect.flatMap(store, (s) =>
					s.setPermissionMode(initialSession.id, "plan", "pi-plan"),
				).pipe(Effect.result),
			);
			expect(runtimeResult._tag).toBe("Failure");
			expect(permissionResult._tag).toBe("Failure");
			const session = await run(
				Effect.flatMap(store, (s) => s.getSession(initialSession.id)),
			);
			expect(session.runtimeMode).toBe(initialSession.runtimeMode);
			expect(session.permissionMode).toBe(initialSession.permissionMode);
		});
	});
	it("preserves a manually renamed chat after reopening the database", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-chat-rename-restart-"));
		const dbPath = join(directory, "test.sqlite");
		const runtime = makeRuntime(dbPath);
		try {
			const chatId = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const now = new Date().toISOString();
					yield* sql`
						INSERT INTO projects (id, path, name, created_at, updated_at)
						VALUES (${PROJECT_ID}, ${directory}, ${"Test"}, ${now}, ${now})
					`;
					const service = yield* store;
					const { chat } = yield* service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					});
					const renamed = yield* service.renameChat(chat.id, "My workspace");
					expect(renamed).toMatchObject({
						title: "My workspace",
						titleProvenance: "manual",
					});

					const latestChatEvent = yield* sql<{
						readonly sequence: number;
					}>`
						SELECT sequence FROM events
						WHERE stream_kind = 'chat' AND stream_id = ${chat.id}
						ORDER BY sequence DESC LIMIT 1
					`;
					const sequence = latestChatEvent[0]?.sequence;
					expect(sequence).toBeDefined();
					if (sequence === undefined) return chat.id;
					yield* sql`
						UPDATE projector_cursors
						SET last_sequence = ${sequence - 1}
						WHERE projector_name = 'chat-read-model'
					`;
					yield* sql`
						UPDATE chats
						SET title = 'New chat', title_provenance = 'pending'
						WHERE id = ${chat.id}
					`;
					return chat.id;
				}),
			);
			await runtime.dispose();
			const restarted = makeRuntime(dbPath, false);
			try {
				const chat = await restarted.runPromise(
					Effect.flatMap(store, (service) => service.getChat(chatId)),
				);
				expect(chat).toMatchObject({
					title: "My workspace",
					titleProvenance: "manual",
				});
			} finally {
				await restarted.dispose();
			}
		} finally {
			await runtime.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("renameSession, setRuntimeMode and setPermissionMode persist", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const id = initialSession.id;

			await run(
				Effect.flatMap(store, (s) =>
					Effect.all([
						s.renameSession(id, "Renamed", "rename-command"),
						s.setRuntimeMode(id, "full-access", "runtime-command"),
						s.setPermissionMode(id, "plan", "permission-command"),
					]),
				),
			);

			const got = await run(Effect.flatMap(store, (s) => s.getSession(id)));
			expect(got.title).toBe("Renamed");
			expect(got.runtimeMode).toBe("full-access");
			expect(got.permissionMode).toBe("plan");
		});
	});

	it.each([
		"warm",
		"running",
	] as const)("retires %s full access before locking and persists native automatic review", async (runtimeState) => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						runtimeMode: "full-access",
					}),
				),
			);
			const id = initialSession.id;
			if (runtimeState === "running") {
				await run(
					Effect.flatMap(store, (s) =>
						s.sendMessage(testCommandId("access-test"), id, "Start working"),
					),
				);
				await expect.poll(() => activeProviderSessions.has(id)).toBe(true);
			} else {
				activeProviderSessions.add(id);
			}
			await run(
				Effect.flatMap(store, (s) =>
					s.setRuntimeMode(id, "full-access", "same-access"),
				),
			);
			expect(activeProviderSessions.has(id)).toBe(true);
			await run(
				Effect.flatMap(store, (s) =>
					s.setRuntimeMode(id, "approval-required", "lock-access"),
				),
			);
			expect(activeProviderSessions.has(id)).toBe(false);
			expect(
				await run(Effect.flatMap(store, (s) => s.getSession(id))),
			).toMatchObject({ runtimeMode: "approval-required", status: "idle" });
			await run(
				Effect.flatMap(store, (s) =>
					s.setRuntimeMode(id, "auto", "automatic-review"),
				),
			);
			expect(
				await run(Effect.flatMap(store, (s) => s.getSession(id))),
			).toMatchObject({ runtimeMode: "auto" });
		});
	});

	it("sendMessage appends a user message to the log", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const id = initialSession.id;

			await run(
				Effect.flatMap(store, (s) =>
					s.sendMessage(testCommandId("messages.send"), id, "hello there"),
				),
			);

			const messages = await run(
				Effect.flatMap(store, (s) => s.listMessages(id)),
			);
			const user = messages.filter((m) => m.role === "user");
			expect(user.length).toBeGreaterThanOrEqual(1);
			expect(user.at(-1)?.content).toMatchObject({
				_tag: "user",
				text: "hello there",
			});
		});
	});

	it("keeps a durable turn retryable when provider recovery cannot start", async () => {
		await withRuntime(async (run) => {
			const { chat, initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			await expect
				.poll(() =>
					run(Effect.flatMap(store, (s) => s.getSession(initialSession.id))),
				)
				.toMatchObject({ status: "idle" });

			failProviderSend = true;
			failProviderStart = true;

			await expect(
				run(
					Effect.flatMap(store, (s) =>
						s.sendMessage(
							testCommandId("messages.send"),
							initialSession.id,
							"trigger provider recovery",
						),
					),
				),
			).rejects.toThrow("scripted start failure");

			const evidence = await run(
				Effect.gen(function* () {
					const service = yield* store;
					const session = yield* service.getSession(initialSession.id);
					const messages = yield* service.listMessages(initialSession.id);
					const currentChat = yield* service.getChat(chat.id);
					const domain = yield* SessionDomain;
					const sendJobs = (yield* domain.jobs.listBySession(
						initialSession.id,
					)).filter((job) => job.request._tag === "provider.turn.send");
					return { session, messages, currentChat, sendJobs };
				}),
			);

			expect(evidence.session.status).toBe("error");
			expect(
				evidence.messages.some((message) => message.content._tag === "user"),
			).toBe(true);
			expect(evidence.currentChat.title).toBe("New chat");

			expect(evidence.sendJobs).toHaveLength(1);
			expect(evidence.sendJobs[0]).toMatchObject({
				status: "failed",
				attemptCount: 1,
			});
			expect(evidence.sendJobs[0]?.lastError).toContain(
				"scripted start failure",
			);

			failProviderSend = false;
			failProviderStart = false;
			await run(
				Effect.flatMap(store, (s) => s.resumeSession(initialSession.id)),
			);
			await expect
				.poll(() =>
					providerSentTexts.filter(
						(text) => text === "trigger provider recovery",
					),
				)
				.toHaveLength(1);
		});
	});

	it.each([
		[false, false],
		[true, false],
		[false, true],
	])("does not replay failed startup after restart (archived=%s, legacyWaiting=%s)", async (archived, legacyWaiting) => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-archived-turn-"));
		const dbPath = join(directory, "test.sqlite");
		const first = makeRuntime(dbPath);
		const runFirst = <A>(effect: Effect.Effect<A, unknown, unknown>) =>
			first.runPromise(effect as Effect.Effect<A, unknown, never>);
		try {
			await runFirst(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const now = new Date().toISOString();
					yield* sql`
						INSERT INTO projects (id, path, name, created_at, updated_at)
						VALUES (${PROJECT_ID}, ${directory}, ${"Test"}, ${now}, ${now})
					`;
				}),
			);
			const { initialSession } = await runFirst(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			await expect
				.poll(() =>
					runFirst(
						Effect.flatMap(store, (service) =>
							service.getSession(initialSession.id),
						),
					),
				)
				.toMatchObject({ status: "idle" });

			failProviderSend = true;
			failProviderStart = true;
			await expect(
				runFirst(
					Effect.flatMap(store, (service) =>
						service.sendMessage(
							testCommandId("messages.send"),
							initialSession.id,
							"archive failed turn",
						),
					),
				),
			).rejects.toThrow("scripted start failure");
			failProviderSend = false;
			failProviderStart = false;

			if (archived)
				await runFirst(
					Effect.flatMap(SessionDomain, (domain) =>
						domain.dispatch({
							commandId: "test:archive-failed-turn",
							streamId: initialSession.id,
							command: {
								_tag: "ArchiveSession",
								archivedAt: Date.now(),
							},
						}),
					),
				);
			const pendingBeforeRestart = await runFirst(
				Effect.flatMap(SessionDomain, (domain) =>
					domain.jobs.listBySession(initialSession.id),
				),
			);
			expect(
				pendingBeforeRestart.filter(
					(job) => job.request._tag === "provider.turn.send",
				),
			).toMatchObject([{ status: "failed" }]);
			if (legacyWaiting) {
				await runFirst(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						yield* sql`UPDATE jobs SET status = 'waiting', completed_at = NULL
						WHERE session_id = ${initialSession.id} AND kind = 'provider.turn.send'`;
					}),
				);
			}
			await first.dispose();

			const startsBeforeRestart = providerStartInputs.length;
			const restarted = makeRuntime(dbPath, false);
			const runRestarted = <A>(effect: Effect.Effect<A, unknown, unknown>) =>
				restarted.runPromise(effect as Effect.Effect<A, unknown, never>);
			try {
				await expect
					.poll(() =>
						runRestarted(
							Effect.flatMap(SessionDomain, (domain) =>
								domain.jobs.listBySession(initialSession.id),
							),
						).then((jobs) =>
							jobs
								.filter((job) => job.request._tag === "provider.turn.send")
								.map((job) => job.status),
						),
					)
					.toEqual(["failed"]);
				expect(providerStartInputs).toHaveLength(startsBeforeRestart);
				if (!archived) {
					await runRestarted(
						Effect.flatMap(store, (service) =>
							service.resumeSession(initialSession.id),
						),
					);
					await expect
						.poll(() =>
							providerSentTexts.filter(
								(text) => text === "archive failed turn",
							),
						)
						.toHaveLength(1);
				}
			} finally {
				await restarted.dispose();
			}
		} finally {
			await first.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("sendMessage with origin persists origin without changing provider text", async () => {
		await withRuntime(async (run) => {
			const { initialSession, chat } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const origin = {
				chatId: chat.id,
				sessionId: initialSession.id,
				providerId: "claude" as const,
			};

			await run(
				Effect.flatMap(store, (s) =>
					s.sendMessage(
						testCommandId("messages.send"),
						initialSession.id,
						"do the thing",
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						origin,
					),
				),
			);

			const messages = await run(
				Effect.flatMap(store, (s) => s.listMessages(initialSession.id)),
			);
			expect(messages.at(-1)?.content).toMatchObject({
				_tag: "user",
				text: "do the thing",
				origin,
			});
			const sent = providerSentTexts.at(-1) ?? "";
			expect(sent).toBe("do the thing");
		});
	});

	it("sendMessage persists the user row under a supplied clientMessageId", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const id = initialSession.id;
			const clientId = MessageId.make(`m_client_${Date.now()}`);

			await run(
				Effect.flatMap(store, (s) =>
					s.sendMessage(
						testCommandId("messages.send"),
						id,
						"with a client id",
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						clientId,
					),
				),
			);

			const messages = await run(
				Effect.flatMap(store, (s) => s.listMessages(id)),
			);
			const user = messages.filter((m) => m.role === "user");

			expect(user.some((m) => m.id === clientId)).toBe(true);
		});
	});

	it("sendMessageWithInput preserves causal identities and the authenticated author in events and projections", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const messageId = MessageId.make("message-cloud-api-causal");
			const turnId = AgentTurnId.make("turn-cloud-api-causal");
			const actor = {
				subject: "user-author",
				membershipId: "membership-author",
			};
			await run(
				Effect.flatMap(store, (messages) =>
					messages.sendMessageWithInput({
						commandId: "api:message-cloud-api-causal",
						sessionId: initialSession.id,
						text: "keep this command and turn paired",
						actor,
						messageId,
						turnId,
					}),
				),
			);

			const persisted = await run(
				Effect.flatMap(SessionDomain, (domain) =>
					domain.events({ streamId: initialSession.id }).pipe(
						Stream.filter(
							(record) =>
								record.event._tag === "MessagePersisted" &&
								record.event.messageId === messageId,
						),
						Stream.runHead,
					),
				),
			);
			expect(persisted).toMatchObject({
				_tag: "Some",
				value: {
					event: {
						turnId,
						contentJson: expect.stringContaining(
							'"membershipId":"membership-author"',
						),
					},
				},
			});
			const messages = await run(
				Effect.flatMap(store, (service) =>
					service.listMessages(initialSession.id),
				),
			);
			expect(
				messages.find((message) => message.id === messageId)?.content,
			).toMatchObject({ actor });
		});
	});

	it("send-and-wait pins durable identities across observer timeouts and command replay", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const input = {
				sessionId: initialSession.id,
				commandId: "wait-idempotent-send",
				text: "perform this once",
			};
			const first = await run(
				Effect.flatMap(store, (s) =>
					s.sendMessageAndWait(input, { target: "done", timeoutMs: 30 }),
				),
			);
			const second = await run(
				Effect.flatMap(store, (s) =>
					s.sendMessageAndWait(input, { target: "done", timeoutMs: 30 }),
				),
			);
			expect(second.turnId).toBe(first.turnId);
			expect(second.attemptId).toBe(first.attemptId);
			const messages = await run(
				Effect.flatMap(store, (s) => s.listMessages(initialSession.id)),
			);
			expect(
				messages.filter((message) => message.role === "user"),
			).toHaveLength(1);
		});
	});

	it("sendMessageWithInput returns the original causal identities on command replay", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const commandId = "api:message-cloud-api-upgrade-replay";
			const original = await run(
				Effect.flatMap(store, (messages) =>
					messages.sendMessageWithInput({
						commandId,
						sessionId: initialSession.id,
						text: "accepted before the runtime upgrade",
					}),
				),
			);

			const attemptedMessageId = MessageId.make("message-upgraded-attempt");
			const attemptedTurnId = AgentTurnId.make("turn-upgraded-attempt");
			const replayed = await run(
				Effect.flatMap(store, (messages) =>
					messages.sendMessageWithInput({
						commandId,
						sessionId: initialSession.id,
						text: "accepted before the runtime upgrade",
						messageId: attemptedMessageId,
						turnId: attemptedTurnId,
					}),
				),
			);

			expect(original.accepted).toBe(true);
			expect(original.messageId).toBeDefined();
			expect(original.turnId).toBeDefined();
			expect(replayed).toEqual(original);
			expect(replayed.messageId).not.toBe(attemptedMessageId);
			expect(replayed.turnId).not.toBe(attemptedTurnId);
		});
	});

	it("sendMessage stores human annotations and sends them as provider context", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const id = initialSession.id;
			const annotations = [
				{
					id: "ann-human-1",
					relPath: "src/app.ts",
					absPath: "/tmp/project/src/app.ts",
					startLine: 12,
					endLine: 16,
					comment: "make this branch easier to follow",
				},
			];

			await run(
				Effect.flatMap(store, (s) =>
					s.sendMessage(
						testCommandId("messages.send"),
						id,
						"please handle this",
						undefined,
						undefined,
						undefined,
						annotations,
					),
				),
			);

			const messages = await run(
				Effect.flatMap(store, (s) => s.listMessages(id)),
			);
			const user = messages.filter((m) => m.role === "user").at(-1);
			expect(user?.content).toMatchObject({
				_tag: "user_rich",
				text: "please handle this",
				annotations,
			});
			expect(providerSentTexts.at(-1)).toBe(
				"Code annotations:\n1. src/app.ts:12-16 — make this branch easier to follow\n\nplease handle this",
			);
		});
	});

	it("sendMessage serializes browser annotations without leaking page text", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const id = initialSession.id;
			const annotations = [
				{
					_tag: "browser" as const,
					id: "ann-browser-1",
					comment: "this hero copy can be improved",
					createdAt: "2026-07-07T00:00:00.000Z",
					pageUrl: "https://example.com/",
					pageTitle: "Example Domain",
					elements: [
						{
							tagName: "p",
							selector: "main > p",
							label: "p",
							rect: { x: 10, y: 20, width: 400, height: 80 },
							textPreview:
								"RAW PAGE TEXT THAT SHOULD NOT BE SERIALIZED INTO PROMPT",
						},
					],
					regions: [],
					strokes: [],
					screenshotAttachment: {
						id: "shot-browser-1",
						mimeType: "image/png",
						originalName: "browser-annotation.png",
					},
				},
			];

			await run(
				Effect.flatMap(store, (s) =>
					s.sendMessage(
						testCommandId("messages.send"),
						id,
						"",
						[
							{
								id: "shot-browser-1",
								mimeType: "image/png",
								originalName: "browser-annotation.png",
							},
						],
						undefined,
						undefined,
						annotations,
					),
				),
			);

			const sent = providerSentTexts.at(-1) ?? "";
			expect(sent).toContain("Browser annotations:");
			expect(sent).toContain(
				"1. https://example.com/ (Example Domain) — <p> p; this hero copy can be improved. Screenshot attached.",
			);
			expect(sent).not.toContain("RAW PAGE TEXT");
			expect(sent).not.toContain("image/png;base64");
		});
	});

	it("reads legacy context compaction rows without status", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "codex",
						model: "gpt-5",
					}),
				),
			);
			const id = initialSession.id;
			const createdAt = "2026-06-30T07:22:00.000Z";
			const legacyContent = JSON.stringify({
				_tag: "context_compaction",
				itemId: "compact_legacy",
				providerId: "codex",
				startedAt: 1_782_803_407_285,
				durationMs: 31_110,
				beforeTokens: null,
				afterTokens: null,
			});

			await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
            INSERT INTO messages
              (id, session_id, role, kind, content_json, created_at)
            VALUES
              (${"msg_legacy_compact"}, ${id}, ${"system"}, ${"context_compaction"}, ${legacyContent}, ${createdAt})
          `;
				}),
			);

			const messages = await run(
				Effect.flatMap(store, (s) => s.listMessages(id)),
			);
			const compact = messages.find(
				(message) => message.content._tag === "context_compaction",
			);

			expect(compact?.content).toMatchObject({
				_tag: "context_compaction",
				status: "completed",
			});
		});
	});

	it("queued messages persist, update, delete, and reorder", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "keep the session running",
					}),
				),
			);
			const first = new ComposerInput({
				text: "first",
				attachments: [],
				fileRefs: [],
				skillRefs: [],
			});
			const second = new ComposerInput({
				text: "second",
				attachments: [],
				fileRefs: [],
				skillRefs: [],
			});

			const [a, b] = await run(
				Effect.flatMap(store, (s) =>
					Effect.all([
						s.addQueuedMessage(
							testCommandId("messages.queue.add"),
							initialSession.id,
							first,
						),
						s.addQueuedMessage(
							testCommandId("messages.queue.add"),
							initialSession.id,
							second,
						),
					]),
				),
			);
			expect(a.position).toBe(0);
			expect(b.position).toBe(1);

			await run(
				Effect.flatMap(store, (s) =>
					s.updateQueuedMessage(
						testCommandId("messages.queue.update"),
						initialSession.id,
						a.id,
						new ComposerInput({
							text: "first edited",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
						}),
					),
				),
			);
			const reordered = await run(
				Effect.flatMap(store, (s) =>
					s.reorderQueuedMessages(
						testCommandId("messages.queue.reorder"),
						initialSession.id,
						[b.id, a.id],
					),
				),
			);
			expect(reordered.map((item) => item.input.text)).toEqual([
				"second",
				"first edited",
			]);

			await run(
				Effect.flatMap(store, (s) =>
					s.deleteQueuedMessage(
						testCommandId("messages.queue.delete"),
						initialSession.id,
						b.id,
					),
				),
			);
			const remaining = await run(
				Effect.flatMap(store, (s) => s.listQueuedMessages(initialSession.id)),
			);
			expect(remaining.paused).toBe(false);
			expect(remaining.items.map((item) => item.input.text)).toEqual([
				"first edited",
			]);
			expect(remaining.items[0]?.position).toBe(0);
		});
	});

	it("queue insertion is idempotent for a renderer-minted queue id", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "keep the session running",
					}),
				),
			);
			const input = new ComposerInput({
				text: "persist me once",
				attachments: [],
				fileRefs: [],
				skillRefs: [],
			});

			const [first, replay] = await run(
				Effect.flatMap(store, (service) =>
					Effect.all([
						service.addQueuedMessage(
							testCommandId("messages.queue.add"),
							initialSession.id,
							input,
							"q_client_optimistic",
						),
						service.addQueuedMessage(
							testCommandId("messages.queue.add"),
							initialSession.id,
							input,
							"q_client_optimistic",
						),
					]),
				),
			);
			const queue = await run(
				Effect.flatMap(store, (service) =>
					service.listQueuedMessages(initialSession.id),
				),
			);

			expect(replay.id).toBe(first.id);
			expect(queue.items).toHaveLength(1);
			expect(queue.items[0]?.id).toBe("q_client_optimistic");
		});
	});

	it("holds a durable startup item until finalization releases it", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const held = await run(
				Effect.flatMap(store, (service) =>
					service.addQueuedMessage(
						testCommandId("messages.queue.add"),
						initialSession.id,
						ComposerInput.make({
							text: "finalize me",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
						}),
						"q_held_startup",
						false,
					),
				),
			);

			expect(held.ready).toBe(false);
			expect(providerSentTexts).toEqual([]);
			expect(
				(
					await run(
						Effect.flatMap(store, (service) =>
							service.listQueuedMessages(initialSession.id),
						),
					)
				).items.map((item) => item.id),
			).toEqual(["q_held_startup"]);

			await run(
				Effect.flatMap(store, (service) =>
					service.updateQueuedMessage(
						testCommandId("messages.queue.update"),
						initialSession.id,
						held.id,
						held.input,
					),
				),
			);
			await expect.poll(() => providerSentTexts).toEqual(["finalize me"]);
		});
	});

	it("does not resurrect a held startup item deleted during finalization", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const held = await run(
				Effect.flatMap(store, (service) =>
					service.addQueuedMessage(
						testCommandId("messages.queue.add"),
						initialSession.id,
						ComposerInput.make({
							text: "delete me",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
						}),
						"q_deleted_while_held",
						false,
					),
				),
			);
			const result = await run(
				Effect.gen(function* () {
					const service = yield* store;
					yield* service.deleteQueuedMessage(
						testCommandId("messages.queue.delete"),
						initialSession.id,
						held.id,
					);
					return yield* Effect.result(
						service.updateQueuedMessage(
							testCommandId("messages.queue.update"),
							initialSession.id,
							held.id,
							held.input,
						),
					);
				}),
			);

			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure") {
				expect(result.failure._tag).toBe("QueuedMessageNotFoundError");
			}
			expect(providerSentTexts).toEqual([]);
			expect(
				(
					await run(
						Effect.flatMap(store, (service) =>
							service.listQueuedMessages(initialSession.id),
						),
					)
				).items,
			).toEqual([]);
		});
	});

	it("rejects a queue item that would make reconnect snapshots unbounded", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "keep the turn active",
					}),
				),
			);
			const result = await run(
				Effect.flatMap(store, (service) =>
					Effect.result(
						service.addQueuedMessage(
							testCommandId("messages.queue.add.large"),
							initialSession.id,
							new ComposerInput({
								text: "x".repeat(129 * 1024),
								attachments: [],
								fileRefs: [],
								skillRefs: [],
							}),
						),
					),
				),
			);
			expect(result).toMatchObject({
				_tag: "Failure",
				failure: {
					_tag: "QueuedMessageCapacityError",
					reason: "item-too-large",
				},
			});
			const queue = await run(
				Effect.flatMap(store, (service) =>
					service.listQueuedMessages(initialSession.id),
				),
			);
			expect(queue.items).toEqual([]);
		});
	});

	it("preserves goal submission metadata while a startup prompt is queued", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			await run(
				Effect.flatMap(store, (service) =>
					service.addQueuedMessage(
						testCommandId("messages.queue.add"),
						initialSession.id,
						ComposerInput.make({
							text: "goal from startup",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
							asGoal: true,
						}),
						"q_goal_startup",
					),
				),
			);
			await expect
				.poll(async () =>
					(
						await run(
							Effect.flatMap(store, (service) =>
								service.listMessages(initialSession.id),
							),
						)
					).find((message) => message.role === "user"),
				)
				.toMatchObject({
					content: { _tag: "user", text: "goal from startup", goal: true },
				});
			expect(providerSentTexts).toEqual([]);
		});
	});

	it("drains a startup queue when the queue row wins the provider-ready race", async () => {
		await withRuntime(async (run) => {
			const barrier = deferred<void>();
			providerStartBarrier = barrier.promise;
			const created = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						background: true,
					}),
				),
			);
			const input = new ComposerInput({
				text: "send after startup",
				attachments: [],
				fileRefs: [],
				skillRefs: [],
			});
			await run(
				Effect.flatMap(store, (service) =>
					service.addQueuedMessage(
						testCommandId("messages.queue.add"),
						created.initialSession.id,
						input,
						"q_queue_first",
					),
				),
			);
			expect(
				(
					await run(
						Effect.flatMap(store, (service) =>
							service.listMessages(created.initialSession.id),
						),
					)
				).filter((message) => message.role === "user"),
			).toEqual([]);

			barrier.resolve();
			providerStartBarrier = null;
			await expect
				.poll(
					async () =>
						(
							await run(
								Effect.flatMap(store, (service) =>
									service.listQueuedMessages(created.initialSession.id),
								),
							)
						).items.length,
				)
				.toBe(0);

			await expect
				.poll(() => providerSentTexts.filter((text) => text === input.text))
				.toHaveLength(1);
		});
	});

	it("drains a startup queue when provider readiness wins the insertion race", async () => {
		await withRuntime(async (run) => {
			const created = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						background: true,
					}),
				),
			);
			await expect
				.poll(
					async () =>
						(
							await run(
								Effect.flatMap(store, (service) =>
									service.getSession(created.initialSession.id),
								),
							)
						).status,
				)
				.toBe("idle");
			const input = new ComposerInput({
				text: "ready before insert",
				attachments: [],
				fileRefs: [],
				skillRefs: [],
			});
			await run(
				Effect.flatMap(store, (service) =>
					service.addQueuedMessage(
						testCommandId("messages.queue.add"),
						created.initialSession.id,
						input,
						"q_provider_first",
					),
				),
			);
			await expect
				.poll(
					() => providerSentTexts.filter((text) => text === input.text).length,
				)
				.toBe(1);
		});
	});

	it("keeps queued startup work when provider boot fails", async () => {
		await withRuntime(async (run) => {
			failProviderStart = true;
			const created = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						background: true,
					}),
				),
			);
			await run(
				Effect.flatMap(store, (service) =>
					service.addQueuedMessage(
						testCommandId("messages.queue.add"),
						created.initialSession.id,
						new ComposerInput({
							text: "keep me",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
						}),
						"q_boot_failure",
					),
				),
			);
			await expect
				.poll(
					async () =>
						(
							await run(
								Effect.flatMap(store, (service) =>
									service.getSession(created.initialSession.id),
								),
							)
						).status,
				)
				.toBe("error");
			await run(
				Effect.flatMap(store, (service) =>
					service.addQueuedMessage(
						testCommandId("messages.queue.add"),
						created.initialSession.id,
						new ComposerInput({
							text: "keep me after failure",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
						}),
						"q_after_boot_failure",
					),
				),
			);
			const queue = await run(
				Effect.flatMap(store, (service) =>
					service.listQueuedMessages(created.initialSession.id),
				),
			);
			expect(queue.items.map((item) => item.id)).toEqual([
				"q_boot_failure",
				"q_after_boot_failure",
			]);
			expect(providerSentTexts).toEqual([]);
		});
	});

	it("reopens a failed startup and flushes the queued first message", async () => {
		await withRuntime(async (run) => {
			failProviderStart = true;
			providerStartFailureReason =
				"Authentication required. Sign in to Grok to continue.";
			const created = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "grok",
						model: "grok-code-fast-1",
						background: true,
					}),
				),
			);
			await run(
				Effect.flatMap(store, (service) =>
					service.addQueuedMessage(
						testCommandId("messages.queue.add"),
						created.initialSession.id,
						new ComposerInput({
							text: "send after authentication",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
						}),
						"q_auth_startup",
					),
				),
			);
			await expect
				.poll(
					async () =>
						(
							await run(
								Effect.flatMap(store, (service) =>
									service.getSession(created.initialSession.id),
								),
							)
						).status,
				)
				.toBe("error");

			failProviderStart = false;
			await run(
				Effect.flatMap(store, (service) =>
					service.resumeSession(created.initialSession.id),
				),
			);
			await run(
				Effect.flatMap(store, (service) =>
					service.resumeQueuedMessages(
						testCommandId("messages.queue.resume"),
						created.initialSession.id,
					),
				),
			);

			await expect
				.poll(() => providerSentTexts)
				.toEqual(["send after authentication"]);
			await expect
				.poll(
					async () =>
						(
							await run(
								Effect.flatMap(store, (service) =>
									service.listQueuedMessages(created.initialSession.id),
								),
							)
						).items,
				)
				.toEqual([]);
		});
	});

	it("reopens an existing session after a turn restart fails", async () => {
		await withRuntime(async (run) => {
			const created = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "grok",
						model: "grok-code-fast-1",
						background: true,
					}),
				),
			);
			await expect
				.poll(
					async () =>
						(
							await run(
								Effect.flatMap(store, (service) =>
									service.getSession(created.initialSession.id),
								),
							)
						).status,
				)
				.toBe("idle");

			failProviderSend = true;
			failProviderStart = true;
			providerStartFailureReason =
				"Authentication required. Sign in to Grok to continue.";
			await run(
				Effect.flatMap(store, (service) =>
					service.sendMessage(
						testCommandId("messages.send"),
						created.initialSession.id,
						"blocked by authentication",
					),
				),
			);
			await expect
				.poll(
					async () =>
						(
							await run(
								Effect.flatMap(store, (service) =>
									service.getSession(created.initialSession.id),
								),
							)
						).status,
				)
				.toBe("error");

			failProviderSend = false;
			failProviderStart = false;
			await run(
				Effect.flatMap(store, (service) =>
					service.resumeSession(created.initialSession.id),
				),
			);

			await expect
				.poll(() => providerSentTexts)
				.toEqual(["blocked by authentication"]);
		});
	});

	it("restores an atomically claimed queue item when submission fails", async () => {
		await withRuntime(async (run) => {
			const created = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			failProviderSend = true;
			await run(
				Effect.flatMap(store, (service) =>
					service.addQueuedMessage(
						testCommandId("messages.queue.add"),
						created.initialSession.id,
						new ComposerInput({
							text: "restore after failure",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
						}),
						"q_restore_failure",
					),
				),
			);
			await expect.poll(() => providerSendAttempts).toBeGreaterThanOrEqual(1);
			await expect
				.poll(async () =>
					(
						await run(
							Effect.flatMap(store, (service) =>
								service.listQueuedMessages(created.initialSession.id),
							),
						)
					).items.map((item) => item.id),
				)
				.toEqual(["q_restore_failure"]);
			failProviderSend = false;
			await run(
				Effect.flatMap(store, (service) =>
					service.resumeQueuedMessages(
						testCommandId("messages.queue.resume"),
						created.initialSession.id,
					),
				),
			);
			const messages = await run(
				Effect.flatMap(store, (service) =>
					service.listMessages(created.initialSession.id),
				),
			);
			expect(
				messages.filter((message) => message.content._tag === "user"),
			).toHaveLength(1);
			await expect
				.poll(() => providerSentTexts)
				.toEqual(["restore after failure"]);
		});
	});

	it("queued messages preserve human annotations until they are sent", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const input = new ComposerInput({
				text: "",
				attachments: [],
				fileRefs: [],
				skillRefs: [],
				annotations: [
					{
						id: "ann-queued-1",
						relPath: "src/queued.ts",
						absPath: "/tmp/project/src/queued.ts",
						startLine: 4,
						endLine: 4,
						comment: "queued annotation only",
					},
				],
			});

			const queued = await run(
				Effect.flatMap(store, (s) =>
					s.addQueuedMessage(
						testCommandId("messages.queue.add"),
						initialSession.id,
						input,
					),
				),
			);
			expect(queued.input.annotations).toEqual(input.annotations);

			const runNextCommandId = testCommandId("messages.queue.runNext");
			await run(
				Effect.flatMap(store, (s) =>
					s.runQueuedMessageNext(
						runNextCommandId,
						initialSession.id,
						queued.id,
					),
				),
			);

			expect(providerSentTexts.at(-1)).toBe(
				"Code annotations:\n1. src/queued.ts:4 — queued annotation only",
			);
		});
	});

	it("queued messages preserve browser annotations and screenshot attachments", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const input = new ComposerInput({
				text: "apply this visual note",
				attachments: [
					{
						id: "shot-queued-browser",
						mimeType: "image/png",
						originalName: "browser-annotation.png",
					},
				],
				fileRefs: [],
				skillRefs: [],
				annotations: [
					{
						_tag: "browser",
						id: "ann-browser-queued",
						comment: "align this card with the list",
						createdAt: "2026-07-07T00:00:00.000Z",
						pageUrl: "http://localhost:3000/",
						pageTitle: null,
						elements: [],
						regions: [
							{
								id: "region-queued",
								rect: { x: 1, y: 2, width: 3, height: 4 },
							},
						],
						strokes: [],
						screenshotAttachment: {
							id: "shot-queued-browser",
							mimeType: "image/png",
							originalName: "browser-annotation.png",
						},
					},
				],
			});

			const queued = await run(
				Effect.flatMap(store, (s) =>
					s.addQueuedMessage(
						testCommandId("messages.queue.add"),
						initialSession.id,
						input,
					),
				),
			);
			expect(queued.input.annotations).toEqual(input.annotations);
			expect(queued.input.attachments).toEqual(input.attachments);

			const runNextCommandId = testCommandId("messages.queue.runNext");
			await run(
				Effect.flatMap(store, (s) =>
					s.runQueuedMessageNext(
						runNextCommandId,
						initialSession.id,
						queued.id,
					),
				),
			);

			expect(providerSentTexts.at(-1)).toContain(
				"Browser annotations:\n1. http://localhost:3000/ — 1 visual target; align this card with the list. Screenshot attached.\n\napply this visual note",
			);
		});
	});

	it("flushQueuedMessages sends only the head queued item when idle", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			await run(
				Effect.flatMap(store, (s) =>
					Effect.all([
						s.addQueuedMessage(
							testCommandId("messages.queue.add"),
							initialSession.id,
							new ComposerInput({
								text: "queued one",
								attachments: [],
								fileRefs: [],
								skillRefs: [],
							}),
						),
						s.addQueuedMessage(
							testCommandId("messages.queue.add"),
							initialSession.id,
							new ComposerInput({
								text: "queued two",
								attachments: [],
								fileRefs: [],
								skillRefs: [],
							}),
						),
					]),
				),
			);

			await run(
				Effect.flatMap(store, (s) =>
					s.flushQueuedMessages(
						testCommandId("messages.queue.flush"),
						initialSession.id,
					),
				),
			);

			const queue = await run(
				Effect.flatMap(store, (s) => s.listQueuedMessages(initialSession.id)),
			);
			expect(queue.items.map((item) => item.input.text)).toEqual([
				"queued two",
			]);
			const messages = await run(
				Effect.flatMap(store, (s) => s.listMessages(initialSession.id)),
			);
			expect(messages.at(-1)?.content).toMatchObject({
				_tag: "user",
				text: "queued one",
			});
		});
	});

	it("automatically sends the queue head when the active turn completes", async () => {
		const eventsBarrier = deferred<void>();
		providerEventsBarrier = eventsBarrier.promise;
		scriptedEvents = [{ _tag: "Completed", reason: "ended" }];
		try {
			await withRuntime(async (run) => {
				const { initialSession } = await run(
					Effect.flatMap(store, (s) =>
						s.createChat({
							projectId: PROJECT_ID,
							providerId: "claude",
							model: "claude-opus-4-8",
							initialPrompt: "first turn",
						}),
					),
				);
				await run(
					Effect.flatMap(store, (s) =>
						s.addQueuedMessage(
							testCommandId("messages.queue.add"),
							initialSession.id,
							new ComposerInput({
								text: "send automatically",
								attachments: [],
								fileRefs: [],
								skillRefs: [],
							}),
						),
					),
				);

				eventsBarrier.resolve();

				await expect
					.poll(() =>
						providerSentTexts.filter((text) => text === "send automatically"),
					)
					.toEqual(["send automatically"]);
			});
		} finally {
			providerEventsBarrier = null;
			scriptedEvents = [];
		}
	});

	it("automatically sends a message queued while the active turn is booting", async () => {
		const startBarrier = deferred<void>();
		const eventsBarrier = deferred<void>();
		providerStartBarrier = startBarrier.promise;
		providerEventsBarrier = eventsBarrier.promise;
		scriptedEvents = [{ _tag: "Completed", reason: "ended" }];
		try {
			await withRuntime(async (run) => {
				const { initialSession } = await run(
					Effect.flatMap(store, (s) =>
						s.createChat({
							projectId: PROJECT_ID,
							providerId: "claude",
							model: "claude-opus-4-8",
							initialPrompt: "first turn",
						}),
					),
				);
				await run(
					Effect.flatMap(store, (s) =>
						s.addQueuedMessage(
							testCommandId("messages.queue.add"),
							initialSession.id,
							new ComposerInput({
								text: "queued during boot",
								attachments: [],
								fileRefs: [],
								skillRefs: [],
							}),
						),
					),
				);

				startBarrier.resolve();
				providerStartBarrier = null;
				eventsBarrier.resolve();

				await expect
					.poll(() =>
						providerSentTexts.filter((text) => text === "queued during boot"),
					)
					.toEqual(["queued during boot"]);
			});
		} finally {
			providerStartBarrier = null;
			providerEventsBarrier = null;
			scriptedEvents = [];
		}
	});

	it("ordinary auto-queue refuses newly blocking input atomically while intentional queue remains available", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const id = initialSession.id;
			await run(
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql`UPDATE sessions SET provider_reservation_id='input-owner' WHERE id=${id}`,
				),
			);

			await run(
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql`INSERT INTO session_inputs(session_id,kind,request_id,status,owner_json,updated_sequence) VALUES(${id},'question','late-question','pending','{"providerSessionId":"input-owner"}',1)`,
				),
			);
			const input = ComposerInput.make({
				text: "keep this draft",
				attachments: [],
				fileRefs: [],
				skillRefs: [],
				annotations: [],
			});
			const rejected = await run(
				Effect.flatMap(store, (s) =>
					s.addQueuedMessage(
						"ordinary-queue",
						id,
						input,
						"ordinary-item",
						true,
						false,
						undefined,
						true,
					),
				).pipe(Effect.result),
			);
			expect(rejected).toMatchObject({
				_tag: "Failure",
				failure: {
					_tag: "SessionInputBlockedError",
					requestId: "late-question",
				},
			});
			const rows = await run(
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) => sql`SELECT id FROM queued_messages WHERE session_id=${id}`,
				),
			);
			expect(rows).toHaveLength(0);
			const receipts = await run(
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql`SELECT command_id FROM command_receipts WHERE command_id='ordinary-queue'`,
				),
			);
			expect(receipts).toHaveLength(0);
			const deliberate = await run(
				Effect.flatMap(store, (s) =>
					s.addQueuedMessage(
						"explicit-queue",
						id,
						input,
						"explicit-item",
						true,
						false,
					),
				),
			);
			expect(deliberate.id).toBe("explicit-item");
		});
	});

	it("auto-flushes from authoritative turn state when status projection is stale", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			await run(
				Effect.flatMap(SessionDomain, (domain) =>
					domain
						.dispatch({
							commandId: "stale-status-after-settlement",
							streamId: initialSession.id,
							command: {
								_tag: "SetStatus",
								status: "running",
								updatedAt: Date.now(),
							},
						})
						.pipe(Effect.asVoid),
				),
			);
			await run(
				Effect.flatMap(store, (s) =>
					s.addQueuedMessage(
						testCommandId("messages.queue.add"),
						initialSession.id,
						new ComposerInput({
							text: "send despite stale status",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
						}),
					),
				),
			);

			await expect
				.poll(() => providerSentTexts)
				.toContain("send despite stale status");
		});
	});

	it("does not flush while an authoritative turn is active despite stale idle status", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "active turn",
					}),
				),
			);
			await run(
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql`UPDATE sessions SET status = 'idle' WHERE id = ${initialSession.id}`,
				),
			);
			await run(
				Effect.flatMap(store, (s) =>
					s.addQueuedMessage(
						testCommandId("messages.queue.add"),
						initialSession.id,
						new ComposerInput({
							text: "must remain queued",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
						}),
					),
				),
			);

			await expect.poll(() => providerSentTexts).toEqual(["active turn"]);
			const queue = await run(
				Effect.flatMap(store, (s) => s.listQueuedMessages(initialSession.id)),
			);
			expect(queue.items.map((item) => item.input.text)).toEqual([
				"must remain queued",
			]);
		});
	});

	it("restores a cancelled queue edit without auto-flushing it", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			await new Promise((resolve) => setTimeout(resolve, 20));
			await run(
				Effect.flatMap(store, (s) =>
					s.addQueuedMessage(
						testCommandId("messages.queue.add"),
						initialSession.id,
						new ComposerInput({
							text: "keep editing later",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
						}),
						"queue-edit-cancelled",
						true,
						false,
					),
				),
			);
			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(providerSentTexts).toEqual([]);
			const queue = await run(
				Effect.flatMap(store, (s) => s.listQueuedMessages(initialSession.id)),
			);
			expect(queue.items.map((item) => item.input.text)).toEqual([
				"keep editing later",
			]);
		});
	});

	it("flushQueuedMessages does nothing while the session is running", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "already running",
					}),
				),
			);
			await run(
				Effect.flatMap(store, (s) =>
					s.addQueuedMessage(
						testCommandId("messages.queue.add"),
						initialSession.id,
						new ComposerInput({
							text: "wait",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
						}),
					),
				),
			);

			await run(
				Effect.flatMap(store, (s) =>
					s.flushQueuedMessages(
						testCommandId("messages.queue.flush"),
						initialSession.id,
					),
				),
			);

			const queue = await run(
				Effect.flatMap(store, (s) => s.listQueuedMessages(initialSession.id)),
			);
			expect(queue.items.map((item) => item.input.text)).toEqual(["wait"]);
		});
	});

	it("keeps an errored queue blocked until explicit resume", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			await run(
				Effect.flatMap(SessionDomain, (domain) =>
					domain
						.dispatch({
							commandId: "test:error-before-queue",
							streamId: initialSession.id,
							command: {
								_tag: "SetStatus",
								status: "error",
								updatedAt: Date.now(),
							},
						})
						.pipe(Effect.asVoid),
				),
			);
			await run(
				Effect.flatMap(store, (service) =>
					service.addQueuedMessage(
						testCommandId("messages.queue.add"),
						initialSession.id,
						new ComposerInput({
							text: "send after resume",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
						}),
					),
				),
			);
			await run(
				Effect.flatMap(store, (service) =>
					service.flushQueuedMessages(
						testCommandId("messages.queue.flush"),
						initialSession.id,
					),
				),
			);
			let queue = await run(
				Effect.flatMap(store, (service) =>
					service.listQueuedMessages(initialSession.id),
				),
			);
			expect(queue.items.map((item) => item.input.text)).toEqual([
				"send after resume",
			]);

			await run(
				Effect.flatMap(store, (service) =>
					service.resumeQueuedMessages(
						testCommandId("messages.queue.resume"),
						initialSession.id,
					),
				),
			);
			queue = await run(
				Effect.flatMap(store, (service) =>
					service.listQueuedMessages(initialSession.id),
				),
			);
			expect(queue.items).toEqual([]);
		});
	});

	it("reconciles a ready queue for an idle session after restart", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-idle-queue-restart-"));
		const dbPath = join(directory, "test.sqlite");
		const first = makeRuntime(dbPath);
		const runFirst = <A>(effect: Effect.Effect<A, unknown, unknown>) =>
			first.runPromise(effect as Effect.Effect<A, unknown, never>);
		try {
			await runFirst(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const now = new Date().toISOString();
					yield* sql`
						INSERT INTO projects (id, path, name, created_at, updated_at)
						VALUES (${PROJECT_ID}, ${directory}, ${"Test"}, ${now}, ${now})
					`;
				}),
			);
			const { initialSession } = await runFirst(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			await runFirst(
				Effect.flatMap(store, (service) =>
					service.addQueuedMessage(
						testCommandId("messages.queue.add"),
						initialSession.id,
						new ComposerInput({
							text: "recover idle queue",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
						}),
						undefined,
						true,
						false,
					),
				),
			);
			const { initialSession: corruptSession } = await runFirst(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			await runFirst(
				Effect.flatMap(store, (service) =>
					service.addQueuedMessage(
						testCommandId("messages.queue.add"),
						corruptSession.id,
						new ComposerInput({
							text: "corrupt queue",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
						}),
						undefined,
						true,
						false,
					),
				),
			);
			const corruptSessionId =
				corruptSession.id < initialSession.id
					? corruptSession.id
					: initialSession.id;
			const healthySessionId =
				corruptSessionId === corruptSession.id
					? initialSession.id
					: corruptSession.id;
			const healthyText =
				healthySessionId === initialSession.id
					? "recover idle queue"
					: "corrupt queue";
			await runFirst(
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql`UPDATE queued_messages SET input_json = '{' WHERE session_id = ${corruptSessionId}`,
				),
			);
			await first.dispose();

			const restarted = makeRuntime(dbPath, false);
			const runRestarted = <A>(effect: Effect.Effect<A, unknown, unknown>) =>
				restarted.runPromise(effect as Effect.Effect<A, unknown, never>);
			try {
				await expect
					.poll(() =>
						runRestarted(
							Effect.flatMap(store, (service) =>
								service.listMessages(healthySessionId),
							),
						),
					)
					.toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								role: "user",
								content: expect.objectContaining({
									text: healthyText,
								}),
							}),
						]),
					);
				const queue = await runRestarted(
					Effect.flatMap(store, (service) =>
						service.listQueuedMessages(healthySessionId),
					),
				);
				expect(queue.items).toEqual([]);

				await runRestarted(
					Effect.flatMap(
						SqlClient.SqlClient,
						(sql) =>
							sql`UPDATE queued_messages
								SET input_json = ${JSON.stringify({
									text: "recovered corrupt queue",
									attachments: [],
									fileRefs: [],
									skillRefs: [],
								})}
								WHERE session_id = ${corruptSessionId}`,
					),
				);
				await expect
					.poll(() =>
						runRestarted(
							Effect.flatMap(store, (service) =>
								service.listMessages(corruptSessionId),
							),
						),
					)
					.toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								role: "user",
								content: expect.objectContaining({
									text: "recovered corrupt queue",
								}),
							}),
						]),
					);
			} finally {
				await restarted.dispose();
			}
		} finally {
			await first.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("keeps queued work durable when restart cannot correlate a stale running status", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-queue-restart-"));
		const dbPath = join(directory, "test.sqlite");
		const first = makeRuntime(dbPath);
		const runFirst = <A>(effect: Effect.Effect<A, unknown, unknown>) =>
			first.runPromise(effect as Effect.Effect<A, unknown, never>);
		try {
			await runFirst(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const now = new Date().toISOString();
					yield* sql`
						INSERT INTO projects (id, path, name, created_at, updated_at)
						VALUES (${PROJECT_ID}, ${directory}, ${"Test"}, ${now}, ${now})
					`;
				}),
			);
			const { initialSession } = await runFirst(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			await expect
				.poll(() =>
					runFirst(
						Effect.flatMap(store, (service) =>
							service.getSession(initialSession.id),
						),
					),
				)
				.toMatchObject({ status: "idle" });
			const emptySessionStarts = await runFirst(
				Effect.flatMap(SessionDomain, (domain) =>
					domain.jobs.listBySession(initialSession.id),
				),
			);

			expect(emptySessionStarts).toEqual([]);
			await runFirst(
				Effect.flatMap(SessionDomain, (domain) =>
					domain.dispatch({
						commandId: "test:stale-running",
						streamId: initialSession.id,
						command: {
							_tag: "SetStatus",
							status: "running",
							updatedAt: Date.now(),
						},
					}),
				),
			);
			await runFirst(
				Effect.flatMap(store, (service) =>
					service.addQueuedMessage(
						testCommandId("messages.queue.add"),
						initialSession.id,
						new ComposerInput({
							text: "recover this queue",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
						}),
					),
				),
			);
			await first.dispose();

			const restarted = makeRuntime(dbPath, false);
			const runRestarted = <A>(effect: Effect.Effect<A, unknown, unknown>) =>
				restarted.runPromise(effect as Effect.Effect<A, unknown, never>);
			try {
				const messages = await runRestarted(
					Effect.flatMap(store, (service) =>
						service.listMessages(initialSession.id),
					),
				);
				const queue = await runRestarted(
					Effect.flatMap(store, (service) =>
						service.listQueuedMessages(initialSession.id),
					),
				);
				expect(queue.items.map((item) => item.input.text)).toEqual([
					"recover this queue",
				]);
				expect(messages).toEqual([]);
				const recovered = await runRestarted(
					Effect.flatMap(store, (service) =>
						service.getSession(initialSession.id),
					),
				);
				expect(recovered.status).toBe("error");
			} finally {
				await restarted.dispose();
			}
		} finally {
			await first.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([
		"idle",
		"booting",
		"running",
	] as const)("settles an orphaned %s turn on restart without repeating delivery", async (status) => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-orphaned-idle-turn-"));
		const dbPath = join(directory, "test.sqlite");
		const first = makeRuntime(dbPath);
		const runFirst = <A>(effect: Effect.Effect<A, unknown, unknown>) =>
			first.runPromise(effect as Effect.Effect<A, unknown, never>);
		try {
			await runFirst(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const now = new Date().toISOString();
					yield* sql`INSERT INTO projects (id, path, name, created_at, updated_at)
					VALUES (${PROJECT_ID}, ${directory}, ${"Test"}, ${now}, ${now})`;
				}),
			);
			const { initialSession } = await runFirst(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			await runFirst(
				Effect.flatMap(store, (service) =>
					service.sendMessage(
						testCommandId("messages.send"),
						initialSession.id,
						"do not replay this command",
					),
				),
			);
			await runFirst(
				Effect.flatMap(SessionDomain, (domain) =>
					domain.dispatch({
						commandId: "test:orphaned-idle",
						streamId: initialSession.id,
						command: {
							_tag: "SetStatus",
							status,
							updatedAt: Date.now(),
						},
					}),
				),
			);
			const startsBeforeRestart = providerStartInputs.length;
			await first.dispose();
			activeProviderSessions.clear();
			providerTurnIds.clear();
			const restarted = makeRuntime(dbPath, false);
			try {
				await restarted.runPromise(
					Effect.flatMap(store, (service) =>
						service.getSession(initialSession.id),
					),
				);
				await expect
					.poll(() =>
						restarted.runPromise(
							Effect.gen(function* () {
								const sql = yield* SqlClient.SqlClient;
								return yield* sql`SELECT s.status, t.id AS current_turn_id, t.phase AS current_turn_phase FROM sessions s LEFT JOIN session_turns t ON t.session_id = s.id AND t.status IN ('starting', 'running') WHERE s.id = ${initialSession.id}`;
							}),
						),
					)
					.toEqual([
						{
							status: "error",
							current_turn_id: null,
							current_turn_phase: null,
						},
					]);
				expect(providerSentTexts).toEqual(["do not replay this command"]);
				expect(providerStartInputs).toHaveLength(startsBeforeRestart);
			} finally {
				await restarted.dispose();
			}
		} finally {
			await first.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("preserves a paused initial turn across restart until setup releases it", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-paused-restart-"));
		const dbPath = join(directory, "test.sqlite");
		const first = makeRuntime(dbPath);
		const sessionId = SessionId.make("paused-restart");
		const turnId = AgentTurnId.make("paused-restart-turn");
		try {
			await first.runPromise(
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql`INSERT INTO projects (id, path, name, created_at, updated_at) VALUES (${PROJECT_ID}, ${directory}, 'Test', '2026-01-01', '2026-01-01')`,
				),
			);
			await first.runPromise(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialSessionId: sessionId,
						initialTurnId: turnId,
						initialPrompt: "wait for setup",
						queuePaused: true,
						background: true,
					}),
				),
			);
			await first.dispose();
			const restarted = makeRuntime(dbPath, false);
			try {
				expect(
					await restarted.runPromise(
						Effect.flatMap(store, (service) => service.getSession(sessionId)),
					),
				).toMatchObject({ status: "booting" });
				expect(
					await restarted.runPromise(
						Effect.flatMap(SessionDomain, (domain) =>
							domain.activeAttempt(sessionId),
						),
					),
				).toMatchObject({ turnId });
				expect(providerStartInputs).toEqual([]);
				await restarted.runPromise(
					Effect.flatMap(store, (service) =>
						service.releaseInitialTurn(
							"release-after-restart",
							sessionId,
							turnId,
							JSON.stringify({
								text: "wait for setup",
								attachments: [],
								fileRefs: [],
								skillRefs: [],
							}),
						),
					),
				);
				await expect.poll(() => providerSentTexts).toEqual(["wait for setup"]);
			} finally {
				await restarted.dispose();
			}
		} finally {
			await first.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("replays an unreceipted startup turn once without settling it on restart", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-turn-restart-"));
		const dbPath = join(directory, "test.sqlite");
		const first = makeRuntime(dbPath);
		const runFirst = <A>(effect: Effect.Effect<A, unknown, unknown>) =>
			first.runPromise(effect as Effect.Effect<A, unknown, never>);
		try {
			await runFirst(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const now = new Date().toISOString();
					yield* sql`
						INSERT INTO projects (id, path, name, created_at, updated_at)
						VALUES (${PROJECT_ID}, ${directory}, ${"Test"}, ${now}, ${now})
					`;
				}),
			);
			const { initialSession } = await runFirst(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);

			providerStartBarrier = deferred<void>().promise;
			const turnId = AgentTurnId.make("turn_restart_pending");
			await runFirst(
				Effect.flatMap(SessionDomain, (domain) =>
					domain.dispatch({
						commandId: "test:restart-pending-turn",
						streamId: initialSession.id,
						command: {
							_tag: "SubmitTurn",
							turnId,
							messageId: MessageId.make("message_restart_pending"),
							role: "user",
							kind: "user",
							contentJson: JSON.stringify({
								_tag: "user",
								text: "resume exactly once",
							}),
							parentItemId: null,
							providerInputJson: JSON.stringify(
								new ComposerInput({
									text: "resume exactly once",
									attachments: [],
									fileRefs: [],
									skillRefs: [],
								}),
							),
							createdAt: Date.now(),
						},
					}),
				),
			);
			await first.dispose();

			const acquisition = deferred<void>();
			providerStartBarrier = acquisition.promise;
			const restarted = makeRuntime(dbPath, false);
			const runRestarted = <A>(effect: Effect.Effect<A, unknown, unknown>) =>
				restarted.runPromise(effect as Effect.Effect<A, unknown, never>);
			try {
				const recovered = await runRestarted(
					Effect.flatMap(store, (service) =>
						service.getSession(initialSession.id),
					),
				);
				expect(recovered.status).toBe("booting");

				const healthy = await runRestarted(
					Effect.flatMap(store, (service) =>
						service.createChat({
							projectId: PROJECT_ID,
							providerId: "claude",
							model: "claude-opus-4-8",
						}),
					),
				);
				expect(healthy.initialSession.status).toBe("idle");
				await runRestarted(
					Effect.flatMap(store, (service) =>
						service.resumeSession(initialSession.id),
					),
				);
				acquisition.resolve();
				providerStartBarrier = null;
				await expect
					.poll(() => providerSentTexts)
					.toEqual(["resume exactly once"]);
				await expect
					.poll(() =>
						runRestarted(
							Effect.flatMap(store, (service) =>
								service.getSession(initialSession.id),
							),
						).then((session) => session.status),
					)
					.toBe("running");
				expect(providerSentTexts).toEqual(["resume exactly once"]);
				const sendJobs = await runRestarted(
					Effect.flatMap(SessionDomain, (domain) =>
						domain.jobs.listBySession(initialSession.id),
					),
				).then((jobs) =>
					jobs.filter((job) => job.request._tag === "provider.turn.send"),
				);
				expect(sendJobs).toMatchObject([
					{ status: "succeeded", attemptCount: 1 },
				]);
			} finally {
				acquisition.resolve();
				providerStartBarrier = null;
				await restarted.dispose();
			}
		} finally {
			await first.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("submits Grok goals through the durable turn delivery ledger", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "grok",
						model: "grok-code-fast-1",
					}),
				),
			);
			const result = await run(
				Effect.flatMap(store, (s) =>
					s.sendMessageWithInput({
						commandId: "goal-send",
						sessionId: initialSession.id,
						text: "implement durable goal",
						asGoal: true,
					}),
				),
			);
			expect(result.accepted).toBe(true);
			await expect
				.poll(() => providerSentGoals)
				.toEqual([{ objective: "implement durable goal", status: "active" }]);
			const events = await run(
				Effect.flatMap(SessionDomain, (domain) =>
					domain.events({ streamId: initialSession.id }).pipe(
						Stream.takeUntil((record) => record.event._tag === "TurnStarted"),
						Stream.runCollect,
					),
				),
			);
			expect(events.some((event) => event.event._tag === "TurnStarted")).toBe(
				true,
			);
			const messages = await run(
				Effect.flatMap(store, (s) => s.listMessages(initialSession.id)),
			);
			expect(
				messages.find((message) => message.role === "user")?.content,
			).toMatchObject({ goal: true, text: "implement durable goal" });
		});
	});
	it("manual interrupt pauses the active goal and publishes the paused state", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "codex",
						model: "gpt-5.6-sol",
						initialPrompt: "pursue this goal",
					}),
				),
			);
			providerGoals.set(
				initialSession.id,
				ThreadGoal.make({
					threadId: initialSession.id,
					objective: "Test interrupt goal",
					status: "active",
					tokenBudget: null,
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: 1,
					updatedAt: 1,
				}),
			);
			await run(Effect.flatMap(store, (s) => s.getGoal(initialSession.id)));
			const paused = run(
				Effect.flatMap(store, (s) =>
					Stream.runHead(
						s
							.streamGoal(initialSession.id)
							.pipe(Stream.filter((event) => event.goal?.status === "paused")),
					),
				),
			).catch(() => null);
			await run(
				Effect.flatMap(store, (s) =>
					s.interruptSession(
						testCommandId("messages.interrupt"),
						initialSession.id,
					),
				),
			);
			expect(providerGoals.get(initialSession.id)?.status).toBe("paused");
			await expect(paused).resolves.toMatchObject({
				value: { goal: { status: "paused" } },
			});
		});
	});
	it("interrupts native work before a slow goal pause acknowledges", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "codex",
						model: "gpt-5.6-sol",
						initialPrompt: "keep working",
					}),
				),
			);
			providerGoals.set(
				initialSession.id,
				ThreadGoal.make({
					threadId: initialSession.id,
					objective: "keep working",
					status: "active",
					tokenBudget: null,
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: 1,
					updatedAt: 1,
				}),
			);
			await run(Effect.flatMap(store, (s) => s.getGoal(initialSession.id)));
			const barrier = deferred<void>();
			providerGoalBarrier = barrier.promise;
			const stopping = run(
				Effect.flatMap(store, (s) =>
					s.interruptSession(
						testCommandId("messages.interrupt"),
						initialSession.id,
					),
				),
			);
			try {
				await expect
					.poll(() =>
						providerInterruptCalls.some(
							(call) => call.sessionId === initialSession.id,
						),
					)
					.toBe(true);
			} finally {
				barrier.resolve(undefined);
				await stopping;
			}
		});
	});
	it("manual interrupt pauses queued messages and blocks auto-flush", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "already running",
					}),
				),
			);
			await run(
				Effect.flatMap(store, (s) =>
					s.addQueuedMessage(
						testCommandId("messages.queue.add"),
						initialSession.id,
						new ComposerInput({
							text: "resume me",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
						}),
					),
				),
			);

			await run(
				Effect.flatMap(store, (s) =>
					s.interruptSession(
						testCommandId("messages.interrupt"),
						initialSession.id,
					),
				),
			);

			await run(
				Effect.flatMap(store, (s) =>
					s.interruptSession(
						testCommandId("messages.interrupt"),
						initialSession.id,
					),
				),
			);
			await run(
				Effect.flatMap(store, (s) =>
					s.flushQueuedMessages(
						testCommandId("messages.queue.flush"),
						initialSession.id,
					),
				),
			);

			const queue = await run(
				Effect.flatMap(store, (s) => s.listQueuedMessages(initialSession.id)),
			);
			expect(queue.paused).toBe(true);
			expect(queue.items.map((item) => item.input.text)).toEqual(["resume me"]);
			const interruptEvents = await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					return yield* sql<{ readonly type: string }>`
						SELECT type FROM events
						WHERE stream_id = ${initialSession.id}
							AND type IN (
								'TurnInterruptRequested',
								'TurnInterruptAcknowledged',
								'TurnSettled'
							)
						ORDER BY stream_version
					`;
				}),
			);
			expect(interruptEvents.map((event) => event.type)).toEqual([
				"TurnInterruptRequested",
				"TurnInterruptAcknowledged",
				"TurnSettled",
			]);
			const interruptedSession = await run(
				Effect.flatMap(store, (s) => s.getSession(initialSession.id)),
			);
			expect(interruptedSession.status).toBe("idle");
		});
	});

	it("does not let a delayed exact-turn interrupt cancel its successor", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "codex",
						model: "gpt-5.6-sol",
					}),
				),
			);
			const goal = await run(
				Effect.flatMap(store, (s) =>
					s.setGoal(initialSession.id, {
						objective: "Keep pursuing the successor",
						status: "active",
					}),
				),
			);

			providerGoals.set(initialSession.id, goal);
			await run(Effect.flatMap(store, (s) => s.getGoal(initialSession.id)));
			const firstTurn = requireProviderTurnId(initialSession.id);
			const successorTurn = AgentTurnId.make("turn-successor");
			await run(
				Effect.gen(function* () {
					const domain = yield* SessionDomain;
					const state = yield* ConversationState;
					yield* domain.dispatch({
						commandId: "test:settle-first",
						streamId: initialSession.id,
						command: {
							_tag: "SettleTurn",
							turnId: firstTurn,
							outcome: "completed",
							settledAt: Date.now(),
						},
					});
					state.clearActiveTurn(initialSession.id);
					yield* domain.dispatch({
						commandId: "test:start-successor",
						streamId: initialSession.id,
						command: {
							_tag: "StartTurn",
							turnId: successorTurn,
							startedAt: Date.now(),
						},
					});
					state.rememberActiveTurn(initialSession.id, successorTurn);
				}),
			);

			const stale = await run(
				Effect.flatMap(store, (s) =>
					s.interruptSession(
						testCommandId("messages.interrupt"),
						initialSession.id,
						firstTurn,
					),
				),
			);
			expect(stale).toEqual({
				_tag: "not-active",
				reason: "turn-mismatch",
				expectedTurnId: firstTurn,
				actualTurnId: successorTurn,
			});
			expect(providerInterruptCalls).toEqual([]);
			expect(providerGoals.get(initialSession.id)?.status).toBe("active");

			const accepted = await run(
				Effect.flatMap(store, (s) =>
					s.interruptSession(
						testCommandId("messages.interrupt"),
						initialSession.id,
						successorTurn,
					),
				),
			);
			expect(providerGoals.get(initialSession.id)?.status).toBe("paused");
			expect(accepted).toEqual({
				_tag: "requested",
				turnId: successorTurn,
			});
			expect(providerInterruptCalls).toEqual([
				{ sessionId: initialSession.id, turnId: successorTurn },
			]);
		});
	});

	it("runs a queued message next before the client timeline knows the active turn", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "already running",
					}),
				),
			);
			const queued = await run(
				Effect.flatMap(store, (s) =>
					s.addQueuedMessage(
						testCommandId("messages.queue.add"),
						initialSession.id,
						new ComposerInput({
							text: "run this next",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
						}),
					),
				),
			);

			const runNextCommandId = testCommandId("messages.queue.runNext");
			await run(
				Effect.flatMap(store, (s) =>
					s.runQueuedMessageNext(
						runNextCommandId,
						initialSession.id,
						queued.id,
					),
				),
			);

			await run(
				Effect.flatMap(store, (s) =>
					s.runQueuedMessageNext(
						runNextCommandId,
						initialSession.id,
						queued.id,
					),
				),
			);

			const queue = await run(
				Effect.flatMap(store, (s) => s.listQueuedMessages(initialSession.id)),
			);
			expect(queue.items).toHaveLength(0);
			const messages = await run(
				Effect.flatMap(store, (s) => s.listMessages(initialSession.id)),
			);
			expect(messages.at(-1)?.content).toMatchObject({
				_tag: "user",
				text: "run this next",
			});
		});
	});

	it("starts a steered successor after the requesting client disconnects", async () => {
		await withRuntime(async (run) => {
			const interruptBarrier = deferred<void>();
			providerInterruptBarrier = interruptBarrier.promise;
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "already running",
					}),
				),
			);
			const queued = await run(
				Effect.flatMap(store, (s) =>
					s.addQueuedMessage(
						testCommandId("messages.queue.add"),
						initialSession.id,
						new ComposerInput({
							text: "steer here",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
						}),
					),
				),
			);

			await run(
				Effect.gen(function* () {
					const service = yield* store;
					const sql = yield* SqlClient.SqlClient;
					const requestFiber = yield* Effect.forkChild(
						service.runQueuedMessageNext(
							testCommandId("messages.queue.runNext"),
							initialSession.id,
							queued.id,
						),
					);
					yield* Effect.gen(function* () {
						const rows = yield* sql<{ readonly count: number }>`
							SELECT COUNT(*) AS count FROM events
							WHERE stream_id = ${initialSession.id}
								AND type = 'TurnInterruptRequested'
						`;
						if ((rows[0]?.count ?? 0) === 0) {
							return yield* Effect.fail("steer interrupt not requested");
						}
					}).pipe(
						Effect.retry(
							Schedule.max([
								Schedule.spaced("10 millis"),
								Schedule.recurs(100),
							]),
						),
					);
					yield* Fiber.interrupt(requestFiber);
					yield* Effect.sync(() => interruptBarrier.resolve());
					yield* Effect.tryPromise({
						try: () =>
							expect
								.poll(() =>
									providerSentTexts.filter((text) => text === "steer here"),
								)
								.toEqual(["steer here"]),
						catch: (cause) => cause,
					});
				}),
			);
		});
	});

	it("serializes rapid run-next requests for multiple queued messages", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "already running",
					}),
				),
			);
			const [first, second] = await run(
				Effect.flatMap(store, (s) =>
					Effect.all([
						s.addQueuedMessage(
							testCommandId("messages.queue.add"),
							initialSession.id,
							new ComposerInput({
								text: "first redirect",
								attachments: [],
								fileRefs: [],
								skillRefs: [],
							}),
						),
						s.addQueuedMessage(
							testCommandId("messages.queue.add"),
							initialSession.id,
							new ComposerInput({
								text: "second redirect",
								attachments: [],
								fileRefs: [],
								skillRefs: [],
							}),
						),
					]),
				),
			);

			await run(
				Effect.flatMap(store, (s) =>
					Effect.all(
						[
							s.runQueuedMessageNext(
								testCommandId("messages.queue.runNext"),
								initialSession.id,
								first.id,
							),
							s.runQueuedMessageNext(
								testCommandId("messages.queue.runNext"),
								initialSession.id,
								second.id,
							),
						],
						{ concurrency: "unbounded" },
					),
				),
			);

			const queue = await run(
				Effect.flatMap(store, (s) => s.listQueuedMessages(initialSession.id)),
			);
			expect(queue.items).toHaveLength(0);
			const messages = await run(
				Effect.flatMap(store, (s) => s.listMessages(initialSession.id)),
			);
			expect(
				messages.flatMap((message) =>
					message.content._tag === "user" ? [message.content.text] : [],
				),
			).toEqual(["already running", "first redirect", "second redirect"]);
		});
	});

	it("resume sends one queued turn after the exact interrupted turn settles", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "already running",
					}),
				),
			);
			await run(
				Effect.flatMap(store, (s) =>
					Effect.all([
						s.addQueuedMessage(
							testCommandId("messages.queue.add"),
							initialSession.id,
							new ComposerInput({
								text: "queued one",
								attachments: [],
								fileRefs: [],
								skillRefs: [],
							}),
						),
						s.addQueuedMessage(
							testCommandId("messages.queue.add"),
							initialSession.id,
							new ComposerInput({
								text: "queued two",
								attachments: [],
								fileRefs: [],
								skillRefs: [],
							}),
						),
					]),
				),
			);
			await run(
				Effect.flatMap(store, (s) =>
					s.interruptSession(
						testCommandId("messages.interrupt"),
						initialSession.id,
					),
				),
			);

			await run(
				Effect.flatMap(store, (s) =>
					s.resumeQueuedMessages(
						testCommandId("messages.queue.resume"),
						initialSession.id,
					),
				),
			);
			const afterResume = await run(
				Effect.flatMap(store, (s) => s.listQueuedMessages(initialSession.id)),
			);
			expect(afterResume.paused).toBe(false);
			expect(afterResume.items.map((item) => item.input.text)).toEqual([
				"queued two",
			]);
			const messages = await run(
				Effect.flatMap(store, (s) => s.listMessages(initialSession.id)),
			);
			expect(messages.at(-1)?.content).toMatchObject({
				_tag: "user",
				text: "queued one",
			});
		});
	});

	it("uses an edit made while queue authorization was unavailable", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const input = new ComposerInput({
				text: "stale",
				attachments: [],
				fileRefs: [],
				skillRefs: [],
			});
			const item = await run(
				Effect.flatMap(store, (s) =>
					s.addQueuedMessage(
						"slow-queue",
						initialSession.id,
						input,
						"slow-item",
						true,
						false,
					),
				),
			);
			const entered = await Effect.runPromise(Deferred.make<void>());
			const release = await Effect.runPromise(Deferred.make<void>());
			queueAuthorWait = Deferred.succeed(entered, undefined).pipe(
				Effect.andThen(Deferred.await(release)),
			);
			const pending = run(
				Effect.flatMap(store, (s) =>
					s.flushQueuedMessages("slow-flush", initialSession.id),
				),
			);
			await Effect.runPromise(Deferred.await(entered));
			await run(
				Effect.flatMap(store, (s) =>
					s.updateQueuedMessage(
						"edit-during-outage",
						initialSession.id,
						item.id,
						new ComposerInput({ ...input, text: "current" }),
					),
				),
			);
			await Effect.runPromise(Deferred.succeed(release, undefined));
			await pending;
			await run(
				Effect.flatMap(store, (s) =>
					s.flushQueuedMessages("after-outage", initialSession.id),
				),
			);
			const messages = await run(
				Effect.flatMap(store, (s) => s.listMessages(initialSession.id)),
			);
			expect(
				messages.find((message) => message.id === `queued_${item.id}`)?.content,
			).toMatchObject({ text: "current" });
		});
	});

	it("queued prompts retain their original author across edits and execution", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const actor = {
				subject: "queue-author",
				membershipId: "original-membership",
			};
			const input = new ComposerInput({
				text: "queued",
				attachments: [],
				fileRefs: [],
				skillRefs: [],
			});
			const item = await run(
				Effect.flatMap(store, (s) =>
					s.addQueuedMessage(
						"authored-queue",
						initialSession.id,
						input,
						"authored-item",
						false,
						false,
						actor,
					),
				),
			);
			expect(item.actor).toEqual(actor);
			const stored = await run(
				Effect.flatMap(store, (s) => s.listQueuedMessages(initialSession.id)),
			);
			expect(stored.items[0]?.actor).toEqual(actor);
			queueAuthorAllowed = false;
			const edited = await run(
				Effect.flatMap(store, (s) =>
					s.updateQueuedMessage(
						"edit-authored-queue",
						initialSession.id,
						item.id,
						new ComposerInput({ ...input, text: "edited queued prompt" }),
					),
				),
			);
			expect(edited.actor).toEqual(actor);
			await run(
				Effect.flatMap(store, (s) =>
					s.flushQueuedMessages("flush-authored-queue", initialSession.id),
				),
			);
			const messages = await run(
				Effect.flatMap(store, (s) => s.listMessages(initialSession.id)),
			);
			expect(
				messages.find((message) => message.id === `queued_${item.id}`),
			).toBeUndefined();
			const paused = await run(
				Effect.flatMap(store, (s) => s.listQueuedMessages(initialSession.id)),
			);
			expect(paused).toMatchObject({
				paused: true,
				items: [expect.objectContaining({ actor })],
			});
			queueAuthorAllowed = true;
			await run(
				Effect.flatMap(store, (s) =>
					s.runQueuedMessageNext(
						"retry-authorized",
						initialSession.id,
						item.id,
					),
				),
			);
			const resumed = await run(
				Effect.flatMap(store, (s) => s.listMessages(initialSession.id)),
			);
			expect(
				resumed.find((message) => message.id === `queued_${item.id}`)?.content,
			).toMatchObject({ text: "edited queued prompt", actor });
		});
	});

	it("runQueuedMessageNext and flush do not duplicate the same queued row", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const item = await run(
				Effect.flatMap(store, (s) =>
					s.addQueuedMessage(
						testCommandId("messages.queue.add"),
						initialSession.id,
						new ComposerInput({
							text: "send me once",
							attachments: [],
							fileRefs: [],
							skillRefs: [],
						}),
					),
				),
			);

			await run(
				Effect.flatMap(store, (s) =>
					Effect.all(
						[
							s.runQueuedMessageNext(
								testCommandId("messages.queue.runNext"),
								initialSession.id,
								item.id,
							),
							s.flushQueuedMessages(
								testCommandId("messages.queue.flush"),
								initialSession.id,
							),
						],
						{ concurrency: "unbounded" },
					),
				),
			);

			const queue = await run(
				Effect.flatMap(store, (s) => s.listQueuedMessages(initialSession.id)),
			);
			expect(queue.items).toHaveLength(0);
			const messages = await run(
				Effect.flatMap(store, (s) => s.listMessages(initialSession.id)),
			);
			const matching = messages.filter(
				(message) =>
					(message.content._tag === "user" ||
						message.content._tag === "user_rich") &&
					message.content.text === "send me once",
			);
			expect(matching).toHaveLength(1);
		});
	});

	it("archiveSession hides the row unless includeArchived is set", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const id = initialSession.id;

			await run(Effect.flatMap(store, (s) => s.archiveSession(id)));

			const active = await run(
				Effect.flatMap(store, (s) => s.listSessions(PROJECT_ID, false)),
			);
			expect(active.map((x) => x.id)).not.toContain(id);

			const all = await run(
				Effect.flatMap(store, (s) => s.listSessions(PROJECT_ID, true)),
			);
			expect(all.map((x) => x.id)).toContain(id);
		});
	});
});

describe("ConversationServices — provider event persistence", () => {
	it("does not block a later turn while the first-turn name is generated", async () => {
		generatedTitle = "Background Naming";
		generatedBranch = "background-naming";
		const naming = deferred<void>();
		titleGenerationBarrier = naming.promise;
		scriptedEvents = [
			{
				_tag: "AssistantMessage",
				itemId: "i_background_name" as never,
				text: "The first turn is complete.",
			},
			{ _tag: "Completed", reason: "ended" },
		];
		try {
			await withRuntime(async (run) => {
				const created = await run(
					Effect.flatMap(store, (service) =>
						service.createChat({
							projectId: PROJECT_ID,
							providerId: "claude",
							model: "claude-opus-4-8",
							initialPrompt: "Name this chat",
							worktreeId: TEST_WORKTREE_ID,
						}),
					),
				);
				await expect.poll(() => titleGenerationStarts).toBe(1);
				await run(
					Effect.flatMap(store, (service) =>
						service.sendMessage(
							testCommandId("messages.send"),
							created.initialSession.id,
							"deliver while naming",
						),
					).pipe(Effect.timeout("500 millis")),
				);
				expect(providerSentTexts).toContain("deliver while naming");
			});
		} finally {
			naming.resolve();
			titleGenerationBarrier = null;
			scriptedEvents = [];
		}
	});

	it("persists session questions once without assigning them to the active turn", async () => {
		const itemId = AgentItemId.make("startup-question");
		const event: AgentEvent = {
			_tag: "UserQuestion",
			itemId,
			questions: [{ question: "Continue startup?", options: ["Yes"] }],
		};
		scriptedEventScope = "session";
		scriptedEvents = [event, event];
		providerQuestionAttached = true;
		try {
			await withRuntime(async (run) => {
				const { initialSession } = await run(
					Effect.flatMap(store, (service) =>
						service.createChat({
							projectId: PROJECT_ID,
							providerId: "claude",
							model: "claude-opus-4-8",
							initialPrompt: "Start work",
						}),
					),
				);
				const read = () =>
					run(
						Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient;
							return yield* sql`SELECT m.turn_id, i.status FROM messages m JOIN session_inputs i
						ON i.session_id = m.session_id AND i.kind = 'question'
						AND i.request_id = json_extract(m.content_json, '$.itemId')
						WHERE m.session_id = ${initialSession.id} AND m.kind = 'user_question'`;
						}),
					);
				await expect.poll(read).toEqual([{ turn_id: null, status: "pending" }]);
				await run(
					Effect.flatMap(store, (service) =>
						service.answerQuestion(initialSession.id, itemId, [
							{ questionIndex: 0, selected: [0] },
						]),
					),
				);
				const receipts = await run(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						return yield* sql`SELECT turn_id FROM messages WHERE session_id = ${initialSession.id} AND kind = 'user_question_answer'`;
					}),
				);
				expect(receipts).toEqual([{ turn_id: null }]);
			});
		} finally {
			scriptedEventScope = "turn";
			scriptedEvents = [];
		}
	});

	it("keeps provider attachment authority until the durable answer receipt commits", async () => {
		const itemId = "question-post-provider-db-failure" as never;
		const answers = [
			{ questionIndex: 1, selected: [2, 0], other: " custom " },
			{ questionIndex: 0, selected: [1] },
		];
		const semanticallyEquivalentRetry = [
			{ questionIndex: 0, selected: [1] },
			{ questionIndex: 1, selected: [0, 2], other: "custom" },
		];
		scriptedEvents = [
			{
				_tag: "UserQuestion",
				itemId,
				questions: [
					{
						question: "Keep the pending changes?",
						options: ["Keep", "Discard"],
					},
					{
						question: "Which checks should run?",
						options: ["Unit", "Integration", "System"],
						multiSelect: true,
					},
				],
			},
		];
		providerQuestionAttached = true;
		try {
			await withRuntime(async (run) => {
				const { initialSession } = await run(
					Effect.flatMap(store, (service) =>
						service.createChat({
							projectId: PROJECT_ID,
							providerId: "claude",
							model: "claude-opus-4-8",
							initialPrompt: "Ask before changing anything",
						}),
					),
				);
				const sessionId = initialSession.id;
				await expect
					.poll(() =>
						run(
							Effect.flatMap(store, (service) =>
								service.listMessages(sessionId),
							),
						).then((messages) =>
							messages.some(
								(message) => message.content._tag === "user_question",
							),
						),
					)
					.toBe(true);
				await run(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						yield* sql`
							CREATE TRIGGER fail_question_answer_receipt
							BEFORE INSERT ON messages
							WHEN NEW.kind = 'user_question_answer'
							BEGIN
								SELECT RAISE(FAIL, 'injected question answer receipt failure');
							END
						`;
					}),
				);

				const interruptedCommit = await run(
					Effect.flatMap(store, (service) =>
						Effect.exit(service.answerQuestion(sessionId, itemId, answers)),
					),
				);
				expect(interruptedCommit._tag).toBe("Failure");
				expect(providerQuestionContinuations).toBe(1);
				expect(providerQuestionAttached).toBe(true);
				const pending = await run(
					Effect.gen(function* () {
						const service = yield* store;
						const sql = yield* SqlClient.SqlClient;
						return {
							answers: (yield* service.listMessages(sessionId)).filter(
								(message) => message.content._tag === "user_question_answer",
							),
							intents: yield* sql<{ readonly answers_json: string }>`
								SELECT answers_json FROM question_answer_deliveries
								WHERE session_id = ${sessionId} AND item_id = ${itemId}
							`,
						};
					}),
				);
				expect(pending.answers).toEqual([]);
				expect(pending.intents).toEqual([
					{ answers_json: JSON.stringify(answers) },
				]);

				await run(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						yield* sql`DROP TRIGGER fail_question_answer_receipt`;
					}),
				);
				await run(
					Effect.flatMap(store, (service) =>
						service.answerQuestion(
							sessionId,
							itemId,
							semanticallyEquivalentRetry,
						),
					),
				);
				const recovered = await run(
					Effect.gen(function* () {
						const service = yield* store;
						const sql = yield* SqlClient.SqlClient;
						return {
							answers: (yield* service.listMessages(sessionId)).filter(
								(message) => message.content._tag === "user_question_answer",
							),
							intents: yield* sql<{ readonly item_id: string }>`
								SELECT item_id FROM question_answer_deliveries
								WHERE session_id = ${sessionId} AND item_id = ${itemId}
							`,
						};
					}),
				);
				expect(providerAnswerAttempts).toBe(2);
				expect(providerQuestionContinuations).toBe(1);
				expect(providerQuestionAttached).toBe(false);
				expect(recovered.answers).toHaveLength(1);
				expect(recovered.answers[0]?.content).toMatchObject({
					_tag: "user_question_answer",
					answers,
				});
				expect(recovered.intents).toEqual([]);
			});
		} finally {
			scriptedEvents = [];
		}
	});

	it("keeps a rejected question answer pending and delivers its retry exactly once", async () => {
		const itemId = "question-reject-once" as never;
		const answers = [{ questionIndex: 0, selected: [0] }];
		scriptedEvents = [
			{
				_tag: "UserQuestion",
				itemId,
				questions: [
					{
						question: "Keep the pending changes?",
						options: ["Keep", "Discard"],
						multiSelect: false,
					},
				],
			},
		];
		providerQuestionAttached = true;
		failProviderAnswerAttempts = 1;
		try {
			await withRuntime(async (run) => {
				const { initialSession } = await run(
					Effect.flatMap(store, (service) =>
						service.createChat({
							projectId: PROJECT_ID,
							providerId: "claude",
							model: "claude-opus-4-8",
							initialPrompt: "Ask before changing anything",
						}),
					),
				);
				const sessionId = initialSession.id;

				await expect
					.poll(() =>
						run(
							Effect.flatMap(store, (service) =>
								service.listMessages(sessionId),
							),
						).then(
							(messages) =>
								messages.filter(
									(message) =>
										message.content._tag === "user_question" &&
										message.content.itemId === itemId,
								).length,
						),
					)
					.toBe(1);

				const rejected = await run(
					Effect.flatMap(store, (service) =>
						Effect.exit(service.answerQuestion(sessionId, itemId, answers)),
					),
				);
				expect(rejected._tag).toBe("Failure");
				expect(providerAnswerAttempts).toBe(1);

				const afterRejection = await run(
					Effect.flatMap(store, (service) => service.listMessages(sessionId)),
				);
				expect(
					afterRejection.filter(
						(message) =>
							message.content._tag === "user_question_answer" &&
							message.content.itemId === itemId,
					),
				).toEqual([]);

				const pendingDelivery = await run(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						return yield* sql<{
							readonly answers_json: string;
						}>`
								SELECT answers_json
								FROM question_answer_deliveries
								WHERE session_id = ${sessionId} AND item_id = ${itemId}
							`;
					}),
				);
				expect(pendingDelivery).toEqual([
					{ answers_json: JSON.stringify(answers) },
				]);

				const retryGate = deferred<void>();
				providerAnswerBarrier = retryGate.promise;
				const firstRetry = run(
					Effect.flatMap(store, (service) =>
						service.answerQuestion(sessionId, itemId, answers),
					),
				);
				await expect.poll(() => providerAnswerAttempts).toBe(2);
				const concurrentRetry = run(
					Effect.flatMap(store, (service) =>
						service.answerQuestion(sessionId, itemId, answers),
					),
				);
				retryGate.resolve();
				await Promise.all([firstRetry, concurrentRetry]);
				providerAnswerBarrier = null;

				await run(
					Effect.flatMap(store, (service) =>
						service.answerQuestion(sessionId, itemId, answers),
					),
				);

				providerQuestionAttached = true;
				providerQuestionConsumed = false;
				await expect(
					run(
						Effect.flatMap(store, (service) =>
							service.answerQuestion(sessionId, itemId, [
								{ questionIndex: 0, selected: [1] },
							]),
						),
					),
				).rejects.toMatchObject({
					_tag: "QuestionResolutionError",
					sessionId,
					itemId,
				});

				const delivered = await run(
					Effect.gen(function* () {
						const service = yield* store;
						const sql = yield* SqlClient.SqlClient;
						return {
							messages: yield* service.listMessages(sessionId),
							delivery: yield* sql<{ readonly item_id: string }>`
								SELECT item_id FROM question_answer_deliveries
								WHERE session_id = ${sessionId} AND item_id = ${itemId}
							`,
						};
					}),
				);
				expect(providerAnswerAttempts).toBe(3);
				expect(providerAnswerPayloads.at(-1)).toEqual(answers);
				expect(providerQuestionContinuations).toBe(2);
				expect(providerQuestionAttached).toBe(false);
				expect(
					delivered.messages.filter(
						(message) =>
							message.content._tag === "user_question_answer" &&
							message.content.itemId === itemId,
					),
				).toHaveLength(1);
				expect(delivered.delivery).toEqual([]);
			});
		} finally {
			scriptedEvents = [];
		}
	});

	it("does not persist a receipt when callback authority detaches before delivery", async () => {
		const itemId = "question-detach-race" as never;
		const answers = [{ questionIndex: 0, selected: [0] }];
		scriptedEvents = [
			{
				_tag: "UserQuestion",
				itemId,
				questions: [
					{
						question: "Continue?",
						options: ["Continue", "Cancel"],
					},
				],
			},
		];
		providerQuestionAttached = true;
		try {
			await withRuntime(async (run) => {
				const { initialSession } = await run(
					Effect.flatMap(store, (service) =>
						service.createChat({
							projectId: PROJECT_ID,
							providerId: "claude",
							model: "claude-opus-4-8",
							initialPrompt: "Ask before continuing",
						}),
					),
				);
				const sessionId = initialSession.id;
				await expect
					.poll(() =>
						run(
							Effect.flatMap(store, (service) =>
								service.listMessages(sessionId),
							),
						).then((messages) =>
							messages.some(
								(message) =>
									message.content._tag === "user_question" &&
									message.content.itemId === itemId,
							),
						),
					)
					.toBe(true);

				detachProviderQuestionAfterHasCall = providerQuestionHasCalls + 2;
				const raced = await run(
					Effect.flatMap(store, (service) =>
						Effect.result(service.answerQuestion(sessionId, itemId, answers)),
					),
				);
				expect(raced).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "QuestionResolutionError", sessionId, itemId },
				});
				expect(providerAnswerAttempts).toBe(1);
				const pending = await run(
					Effect.gen(function* () {
						const service = yield* store;
						const sql = yield* SqlClient.SqlClient;
						return {
							answers: (yield* service.listMessages(sessionId)).filter(
								(message) =>
									message.content._tag === "user_question_answer" &&
									message.content.itemId === itemId,
							),
							intents: yield* sql<{ readonly item_id: string }>`
								SELECT item_id FROM question_answer_deliveries
								WHERE session_id = ${sessionId} AND item_id = ${itemId}
							`,
						};
					}),
				);
				expect(pending.answers).toEqual([]);
				expect(pending.intents).toEqual([{ item_id: itemId }]);

				detachProviderQuestionAfterHasCall = null;
				providerQuestionAttached = true;
				await run(
					Effect.flatMap(store, (service) =>
						service.answerQuestion(sessionId, itemId, answers),
					),
				);
				const recovered = await run(
					Effect.flatMap(store, (service) => service.listMessages(sessionId)),
				);
				expect(
					recovered.filter(
						(message) =>
							message.content._tag === "user_question_answer" &&
							message.content.itemId === itemId,
					),
				).toHaveLength(1);
				expect(providerQuestionContinuations).toBe(1);
			});
		} finally {
			scriptedEvents = [];
		}
	});

	it("rejects malformed answers before outbox persistence and accepts valid multi/free-text answers", async () => {
		const itemId = "question-answer-validation" as never;
		scriptedEvents = [
			{
				_tag: "UserQuestion",
				itemId,
				questions: [
					{
						question: "Keep the pending changes?",
						options: ["Keep", "Discard"],
						multiSelect: false,
					},
					{
						question: "Which checks should run?",
						options: ["Unit", "Integration", "System"],
						multiSelect: true,
					},
				],
			},
		];
		providerQuestionAttached = true;
		try {
			await withRuntime(async (run) => {
				const { initialSession } = await run(
					Effect.flatMap(store, (service) =>
						service.createChat({
							projectId: PROJECT_ID,
							providerId: "claude",
							model: "claude-opus-4-8",
							initialPrompt: "Ask before continuing",
						}),
					),
				);
				const sessionId = initialSession.id;
				await expect
					.poll(() =>
						run(
							Effect.flatMap(store, (service) =>
								service.listMessages(sessionId),
							),
						).then((messages) =>
							messages.some(
								(message) => message.content._tag === "user_question",
							),
						),
					)
					.toBe(true);

				const validSecond = { questionIndex: 1, selected: [0] };
				const malformed = [
					[],
					[{ questionIndex: 0, selected: [0] }],
					[{ questionIndex: -1, selected: [0] }, validSecond],
					[{ questionIndex: 0.5, selected: [0] }, validSecond],
					[{ questionIndex: 2, selected: [0] }, validSecond],
					[
						{ questionIndex: 0, selected: [0] },
						{ questionIndex: 0, selected: [1] },
					],
					[{ questionIndex: 0, selected: [-1] }, validSecond],
					[{ questionIndex: 0, selected: [0.5] }, validSecond],
					[{ questionIndex: 0, selected: [2] }, validSecond],
					[
						{ questionIndex: 0, selected: [0] },
						{ questionIndex: 1, selected: [0, 0] },
					],
					[{ questionIndex: 0, selected: [0, 1] }, validSecond],
					[{ questionIndex: 0, selected: [] }, validSecond],
					[{ questionIndex: 0, selected: [0], other: "   " }, validSecond],
					[{ questionIndex: 0, selected: [0], other: "Third" }, validSecond],
				];
				for (const answers of malformed) {
					await expect(
						run(
							Effect.flatMap(store, (service) =>
								service.answerQuestion(sessionId, itemId, answers),
							),
						),
					).rejects.toMatchObject({
						_tag: "QuestionResolutionError",
						sessionId,
						itemId,
					});
				}
				const beforeValid = await run(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						return yield* sql<{ readonly count: number }>`
							SELECT COUNT(*) AS count FROM question_answer_deliveries
							WHERE session_id = ${sessionId} AND item_id = ${itemId}
						`;
					}),
				);
				expect(beforeValid).toEqual([{ count: 0 }]);
				expect(providerAnswerAttempts).toBe(0);

				const valid = [
					{
						questionIndex: 1,
						selected: [2, 0],
						other: "Run smoke too",
					},
					{ questionIndex: 0, selected: [], other: "Keep both variants" },
				];
				await run(
					Effect.flatMap(store, (service) =>
						service.answerQuestion(sessionId, itemId, valid),
					),
				);
				const messages = await run(
					Effect.flatMap(store, (service) => service.listMessages(sessionId)),
				);
				expect(providerAnswerAttempts).toBe(1);
				expect(
					messages.find(
						(message) => message.content._tag === "user_question_answer",
					)?.content,
				).toMatchObject({ _tag: "user_question_answer", answers: valid });
			});
		} finally {
			scriptedEvents = [];
		}
	});

	it.each([
		{ attached: true, reattach: false, mode: "live" },
		{ attached: false, reattach: false, mode: "live" },
		{ attached: false, reattach: true, mode: "live" },
		{ attached: true, reattach: false, mode: "expired" },
	])("persists cancellation without a blank answer and rejects answer/cancel conflicts (attached: $attached, reattach: $reattach, mode: $mode)", async ({
		attached,
		reattach,
		mode,
	}) => {
		const itemId = "question-cancel" as never;
		scriptedEvents = [
			{
				_tag: "UserQuestion",
				itemId,
				questions: [{ question: "Continue?", options: ["Continue", "Stop"] }],
			},
		];
		providerQuestionAttached = attached;
		try {
			await withRuntime(async (run) => {
				const { initialSession } = await run(
					Effect.flatMap(store, (service) =>
						service.createChat({
							projectId: PROJECT_ID,
							providerId: "claude",
							model: "claude-opus-4-8",
							initialPrompt: "Ask before continuing",
						}),
					),
				);
				const sessionId = initialSession.id;
				await expect
					.poll(() =>
						run(
							Effect.flatMap(store, (service) =>
								service.listMessages(sessionId),
							),
						).then((messages) =>
							messages.some(
								(message) => message.content._tag === "user_question",
							),
						),
					)
					.toBe(true);

				if (!attached) {
					await expect(
						run(
							Effect.flatMap(store, (service) =>
								service.cancelQuestion(sessionId, "missing-question" as never),
							),
						),
					).rejects.toThrow();
				}

				if (reattach) {
					attachProviderQuestionAfterHasCall = providerQuestionHasCalls + 2;
				}
				if (mode === "expired") {
					providerQuestionAttached = false;
					await expect
						.poll(() =>
							run(
								Effect.gen(function* () {
									const sql = yield* SqlClient.SqlClient;
									const rows = yield* sql<{
										status: string;
									}>`SELECT status FROM session_inputs WHERE session_id = ${sessionId} AND request_id = ${itemId}`;
									return rows[0]?.status;
								}),
							),
						)
						.toBe("expired");
				}

				await run(
					Effect.flatMap(store, (service) =>
						service.cancelQuestion(sessionId, itemId),
					),
				);
				if (reattach) {
					expect(providerQuestionAttached).toBe(true);
					expect(providerCancelAttempts).toBe(0);
					expect(providerQuestionContinuations).toBe(0);
				}

				await run(
					Effect.flatMap(store, (service) =>
						service.cancelQuestion(sessionId, itemId),
					),
				);
				providerQuestionAttached = mode === "live";
				providerQuestionConsumed = false;
				await expect(
					run(
						Effect.flatMap(store, (service) =>
							service.answerQuestion(sessionId, itemId, [
								{ questionIndex: 0, selected: [0] },
							]),
						),
					),
				).rejects.toThrow();

				const persisted = await run(
					Effect.gen(function* () {
						const service = yield* store;
						const sql = yield* SqlClient.SqlClient;
						return {
							messages: yield* service.listMessages(sessionId),
							resolutions: yield* sql<{ readonly count: number }>`
								SELECT COUNT(*) AS count FROM events
								WHERE stream_kind = 'session' AND stream_id = ${sessionId}
								  AND type = 'QuestionResolved'
							`,
							outbox: yield* sql<{ readonly count: number }>`
								SELECT COUNT(*) AS count FROM question_answer_deliveries
								WHERE session_id = ${sessionId} AND item_id = ${itemId}
							`,
						};
					}),
				);
				expect(providerCancelAttempts).toBe(
					mode === "expired" ? 0 : attached || reattach ? 2 : 1,
				);
				expect(providerQuestionContinuations).toBe(
					mode === "expired" ? 0 : attached || reattach ? 2 : 1,
				);
				expect(
					persisted.messages.filter(
						(message) => message.content._tag === "user_question_answer",
					),
				).toEqual([]);
				expect(persisted.resolutions).toEqual([{ count: 1 }]);
				expect(persisted.outbox).toEqual([{ count: 0 }]);
			});
		} finally {
			scriptedEvents = [];
		}
	});

	it("keeps pending New chat titles when the first turn errors", async () => {
		generatedTitle = "Your Organization Has Disabled Access";
		scriptedEvents = [
			{
				_tag: "Error",
				message: "Your organization has disabled provider access.",
			},
			{ _tag: "Completed", reason: "error" },
		];
		try {
			await withRuntime(async (run) => {
				const created = await run(
					Effect.flatMap(store, (service) =>
						service.createChat({
							projectId: PROJECT_ID,
							providerId: "claude",
							model: "claude-opus-4-8",
							initialPrompt: "Review the project",
						}),
					),
				);
				const failed = await run(
					Effect.gen(function* () {
						const service = yield* store;
						const session = yield* service.getSession(
							created.initialSession.id,
						);
						return session.status === "error"
							? {
									chat: yield* service.getChat(created.chat.id),
									session,
								}
							: yield* Effect.fail("first turn has not failed yet" as const);
					}).pipe(
						Effect.retry(
							Schedule.max([
								Schedule.spaced("10 millis"),
								Schedule.recurs(100),
							]),
						),
					),
				);

				expect(failed.chat).toMatchObject({
					title: "New chat",
					titleProvenance: "pending",
				});
				expect(failed.session).toMatchObject({
					title: "New chat",
					titleProvenance: "pending",
				});
			});
		} finally {
			scriptedEvents = [];
		}
	});

	it("names each session from its first turn and names the chat only once", async () => {
		generatedTitle = "Reconnect Reliability";
		generatedBranch = "reconnect-reliability";
		scriptedEvents = [
			{
				_tag: "AssistantMessage",
				itemId: "i_name_initial" as never,
				text: "Reconnect handling is implemented and verified.",
			},
			{ _tag: "Completed", reason: "ended" },
		];
		try {
			await withRuntime(async (run) => {
				const { created, liveRename } = await run(
					Effect.gen(function* () {
						const service = yield* store;
						const liveRenameFiber = yield* service
							.streamChatChanges(PROJECT_ID)
							.pipe(
								Stream.flatMap((change) =>
									change._tag === "snapshot"
										? Stream.fromIterable(change.chats)
										: Stream.succeed(change.chat),
								),
								Stream.filter((chat) => chat.titleProvenance === "automatic"),
								Stream.take(1),
								Stream.runCollect,
								Effect.timeout(2_000),
								Effect.forkChild,
							);
						yield* Effect.sleep("10 millis");
						const created = yield* service.createChat({
							projectId: PROJECT_ID,
							providerId: "claude",
							model: "claude-opus-4-8",
							initialPrompt: "Make reconnect handling reliable",
							worktreeId: TEST_WORKTREE_ID,
						});
						const liveRename = yield* Fiber.join(liveRenameFiber);
						return { created, liveRename };
					}),
				);
				expect(liveRename.map((chat) => chat.title)).toEqual([
					"Reconnect Reliability",
				]);
				const initial = await run(
					Effect.gen(function* () {
						const service = yield* store;
						const chat = yield* service.getChat(created.chat.id);
						const session = yield* service.getSession(
							created.initialSession.id,
						);
						return chat.titleProvenance === "automatic" &&
							session.titleProvenance === "automatic"
							? { chat, session }
							: yield* Effect.fail("not named yet" as const);
					}).pipe(
						Effect.retry(
							Schedule.max([
								Schedule.spaced("10 millis"),
								Schedule.recurs(100),
							]),
						),
					),
				);
				expect(initial.chat.title).toBe("Reconnect Reliability");
				expect(initial.session.title).toBe("Reconnect Reliability");
				expect(renamedBranches).toEqual([
					{
						worktreeId: TEST_WORKTREE_ID,
						branch: "reconnect-reliability",
					},
				]);

				generatedTitle = "Telemetry Session";
				scriptedEvents = [
					{
						_tag: "AssistantMessage",
						itemId: "i_name_later" as never,
						text: "Reconnect telemetry is ready.",
					},
					{ _tag: "Completed", reason: "ended" },
				];
				const later = await run(
					Effect.flatMap(store, (service) =>
						service.createSession({
							chatId: created.chat.id,
							providerId: "claude",
							model: "claude-opus-4-8",
							initialPrompt: "Add reconnect telemetry",
						}),
					),
				);
				const namedLater = await run(
					Effect.gen(function* () {
						const service = yield* store;
						const session = yield* service.getSession(later.id);
						return session.titleProvenance === "automatic"
							? session
							: yield* Effect.fail("not named yet" as const);
					}).pipe(
						Effect.retry(
							Schedule.max([
								Schedule.spaced("10 millis"),
								Schedule.recurs(100),
							]),
						),
					),
				);
				expect(namedLater.title).toBe("Telemetry Session");
				expect(
					await run(Effect.flatMap(store, (s) => s.getChat(created.chat.id))),
				).toMatchObject({
					title: "Reconnect Reliability",
					titleProvenance: "automatic",
				});
				expect(
					await run(
						Effect.flatMap(store, (s) =>
							s.getSession(created.initialSession.id),
						),
					),
				).toMatchObject({ title: "Reconnect Reliability" });

				const manualChat = await run(
					Effect.flatMap(store, (service) =>
						service.renameChat(created.chat.id, "My workspace"),
					),
				);
				expect(manualChat).toMatchObject({
					title: "My workspace",
					titleProvenance: "manual",
				});
			});
		} finally {
			scriptedEvents = [];
		}
	});

	it("persists the provider event cursor after preceding events", async () => {
		scriptedEvents = [
			{
				_tag: "AssistantMessage",
				itemId: "i_cursor" as never,
				text: "persist first",
			},
			{
				_tag: "SessionCursor",
				cursor: "provider-session",
				providerEventCursor: "provider-session-7",
				strategy: "grok-session-id",
			},
		];
		try {
			await withRuntime(async (run) => {
				const { initialSession } = await run(
					Effect.flatMap(store, (s) =>
						s.createChat({
							projectId: PROJECT_ID,
							providerId: "grok",
							model: "grok-4.5",
							initialPrompt: "go",
						}),
					),
				);
				const row = await run(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const rows = yield* sql<{
							readonly provider_event_cursor: string | null;
							readonly message_count: number;
						}>`
							SELECT p.native_head_id AS provider_event_cursor,
								(SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.kind = 'assistant') AS message_count
							FROM sessions s
							LEFT JOIN session_provider_threads p ON p.id = s.active_provider_thread_id
							WHERE s.id = ${initialSession.id}
						`;
						const current = rows[0];
						return current?.provider_event_cursor === "provider-session-7"
							? current
							: yield* Effect.fail("not yet" as const);
					}).pipe(
						Effect.retry(
							Schedule.max([
								Schedule.spaced("10 millis"),
								Schedule.recurs(100),
							]),
						),
					),
				);
				expect(row.message_count).toBeGreaterThan(0);
			});
		} finally {
			scriptedEvents = [];
		}
	});

	it("persists the provider execution reference on its exact active attempt", async () => {
		const finished = deferred<void>();
		providerEventsFinished = () => finished.resolve();
		const reference = {
			provider: "codex" as const,
			nativeThreadId: "native-thread",
			nativeTurnId: "native-turn",
		};
		scriptedEvents = [{ _tag: "NativeTurnStarted", reference }];
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "codex",
						model: "gpt-5.4",
						initialPrompt: "work",
					}),
				),
			);
			await finished.promise;
			const actual = await run(
				Effect.gen(function* () {
					const domain = yield* SessionDomain;
					const queries = makeSqlSessionQueries(yield* SqlClient.SqlClient);
					const active = yield* domain.activeAttempt(initialSession.id);
					if (active === null) return null;
					return yield* queries.attemptProviderTurn(
						initialSession.id,
						active.attemptId,
					);
				}),
			);
			expect(actual).toEqual(reference);
		});
	});

	it.each([
		[
			"PersistMessage",
			{ _tag: "AssistantMessage", itemId: "stale" as never, text: "stale" },
		],
		[
			"SetPermissionMode",
			{ _tag: "PermissionModeChanged", mode: "acceptEdits" },
		],
		[
			"BindProviderThread",
			{
				_tag: "SessionCursor",
				cursor: "stale-thread",
				strategy: "grok-session-id",
			},
		],
		[
			"BindAttemptProviderTurn",
			{
				_tag: "NativeTurnStarted",
				reference: {
					provider: "claude",
					nativeThreadId: "stale-thread",
					nativeTurnId: "stale-turn",
				},
			},
		],
		["FinalizeTurn", { _tag: "Completed", reason: "ended" }],
	] satisfies ReadonlyArray<
		readonly [string, AgentEvent]
	>)("rejects %s when residency is revoked after event admission", async (commandTag, event) => {
		const finished = deferred<void>();
		let intercepted = false;
		scriptedEvents = [event];
		providerEventsFinished = () => finished.resolve();
		beforeProviderWrite = (domain, input) =>
			Effect.gen(function* () {
				if (
					input.expectedProviderSessionId === undefined ||
					input.command._tag !== commandTag ||
					intercepted
				)
					return;
				intercepted = true;
				yield* domain
					.dispatch({
						commandId: `stop-before-${commandTag}`,
						streamId: input.streamId,
						command: { _tag: "RequestProviderStop", requestedAt: Date.now() },
					})
					.pipe(Effect.orDie);
			});
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "work",
					}),
				),
			);
			await finished.promise;
			const result = await run(
				Effect.gen(function* () {
					const domain = yield* SessionDomain;
					const sql = yield* SqlClient.SqlClient;
					return {
						active: yield* domain.activeAttempt(initialSession.id),
						events: yield* sql<{
							type: string;
						}>`SELECT type FROM events WHERE stream_id = ${initialSession.id} AND type IN ('TurnSettled', 'PermissionModeChanged', 'ProviderThreadBound', 'AttemptProviderTurnBound')`,
						messages: yield* sql<{
							kind: string;
						}>`SELECT kind FROM messages WHERE session_id = ${initialSession.id}`,
					};
				}),
			);
			expect(intercepted).toBe(true);
			expect(result.active).not.toBeNull();
			expect(result.events).toEqual([]);
			expect(result.messages.map((row) => row.kind)).toEqual(["user"]);
		});
	});

	it("drops output from a revoked residency while its attempt is still active", async () => {
		const gate = deferred<void>();
		const finished = deferred<void>();
		const started = deferred<void>();
		providerEventsBarrier = gate.promise;
		providerEventsFinished = () => finished.resolve();
		providerEventsStarted = () => started.resolve();
		scriptedEvents = [
			{
				_tag: "AssistantMessage",
				itemId: "revoked-output" as never,
				text: "obsolete output",
			},
			{ _tag: "PermissionModeChanged", mode: "acceptEdits" },
			{
				_tag: "SessionCursor",
				cursor: "obsolete-thread",
				strategy: "grok-session-id",
			},
			{ _tag: "Completed", reason: "ended" },
		];
		try {
			await withRuntime(async (run) => {
				const { initialSession } = await run(
					Effect.flatMap(store, (service) =>
						service.createChat({
							projectId: PROJECT_ID,
							providerId: "claude",
							model: "claude-opus-4-8",
							initialPrompt: "work",
						}),
					),
				);
				await started.promise;
				await run(
					Effect.flatMap(SessionDomain, (domain) =>
						domain.dispatch({
							commandId: "revoke-emitter",
							streamId: initialSession.id,
							command: { _tag: "RequestProviderStop", requestedAt: Date.now() },
						}),
					),
				);
				gate.resolve();
				await finished.promise;
				const result = await run(
					Effect.gen(function* () {
						const domain = yield* SessionDomain;
						const sql = yield* SqlClient.SqlClient;
						return {
							active: yield* domain.activeAttempt(initialSession.id),
							events: yield* sql<{
								type: string;
							}>`SELECT type FROM events WHERE stream_id = ${initialSession.id} AND type IN ('TurnSettled', 'PermissionModeChanged', 'ProviderThreadBound')`,
							messages: yield* sql<{
								kind: string;
							}>`SELECT kind FROM messages WHERE session_id = ${initialSession.id}`,
						};
					}),
				);
				expect(result.active).not.toBeNull();
				expect(result.events).toEqual([]);
				expect(result.messages.map((row) => row.kind)).toEqual(["user"]);
			});
		} finally {
			gate.resolve();
		}
	});

	it("persists a scripted AssistantMessage event as an assistant message", async () => {
		scriptedEvents = [
			{ _tag: "AssistantMessage", itemId: "i_a1" as never, text: "all done" },
			{ _tag: "Completed", reason: "ended" },
		];
		try {
			await withRuntime(async (run) => {
				const { initialSession } = await run(
					Effect.flatMap(store, (s) =>
						s.createChat({
							projectId: PROJECT_ID,
							providerId: "claude",
							model: "claude-opus-4-8",
							initialPrompt: "go",
						}),
					),
				);
				const id = initialSession.id;

				const findAssistant = Effect.flatMap(store, (s) =>
					s.listMessages(id),
				).pipe(
					Effect.map((msgs) => msgs.find((m) => m.role === "assistant")),
					Effect.flatMap((found) =>
						found !== undefined
							? Effect.succeed(found)
							: Effect.fail("not yet" as const),
					),
					Effect.retry(
						Schedule.max([Schedule.spaced("10 millis"), Schedule.recurs(100)]),
					),
					Effect.result,
				);

				const assistant = await run(findAssistant);
				expect(assistant._tag).toBe("Success");
				if (assistant._tag === "Success") {
					expect(assistant.success.content).toMatchObject({
						_tag: "assistant",
						text: "all done",
					});
				}
				const domainTags = await run(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const rows = yield* sql<{ readonly type: string }>`
              SELECT type FROM events
              WHERE stream_id = ${id}
              ORDER BY stream_version
            `;
						const tags = rows.map((row) => row.type);
						return tags.includes("TurnSettled")
							? tags
							: yield* Effect.fail("turn not settled" as const);
					}).pipe(
						Effect.retry(
							Schedule.max([
								Schedule.spaced("10 millis"),
								Schedule.recurs(100),
							]),
						),
					),
				);
				expect(domainTags).toContain("TurnStarted");
				expect(domainTags).toContain("MessagePersisted");
				expect(domainTags).toContain("TurnSettled");
				expect(domainTags).toContain("ProviderAttached");
				const attachments = await run(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						return yield* sql<{
							payload_json: string;
						}>`SELECT payload_json FROM events WHERE stream_id = ${id} AND type = 'ProviderAttached'`;
					}),
				);
				expect(
					attachments.map(
						(row) => JSON.parse(row.payload_json).providerSessionId,
					),
				).toEqual([activeProviderResidencies.get(id)]);
			});
		} finally {
			scriptedEvents = [];
		}
	});

	it("does not persist duplicate tool_use events for equivalent tool input", async () => {
		scriptedEvents = [
			{
				_tag: "ToolUse",
				itemId: "call-read" as never,
				tool: "Read",
				input: { target_file: "/repo/a.ts" },
			},
			{
				_tag: "ToolUse",
				itemId: "call-read" as never,
				tool: "Read",
				input: { file_path: "/repo/a.ts" },
			},
			{ _tag: "Completed", reason: "ended" },
		];
		try {
			await withRuntime(async (run) => {
				const { initialSession } = await run(
					Effect.flatMap(store, (s) =>
						s.createChat({
							projectId: PROJECT_ID,
							providerId: "grok",
							model: "grok-4.5",
							initialPrompt: "read file",
						}),
					),
				);
				const id = initialSession.id;

				const findToolRows = Effect.flatMap(store, (s) =>
					s.listMessages(id),
				).pipe(
					Effect.map((msgs) =>
						msgs.filter((m) => m.content._tag === "tool_use"),
					),
					Effect.flatMap((rows) =>
						rows.length > 0 ? Effect.succeed(rows) : Effect.fail("not yet"),
					),
					Effect.retry(
						Schedule.max([Schedule.spaced("10 millis"), Schedule.recurs(100)]),
					),
				);

				const toolRows = await run(findToolRows);
				expect(toolRows).toHaveLength(1);
				expect(toolRows[0]?.content).toMatchObject({
					_tag: "tool_use",
					itemId: "call-read",
					tool: "Read",
				});
			});
		} finally {
			scriptedEvents = [];
		}
	});
});

describe("ConversationServices cursor streaming", () => {
	type MessagePersistedEvent = Extract<
		SessionEvent,
		{ readonly _tag: "MessagePersisted" }
	>;
	type StoredMessagePersistedEvent = StoredEvent<MessagePersistedEvent>;
	const isMessagePersisted = (
		record: StoredEvent,
	): record is StoredMessagePersistedEvent =>
		record.event._tag === "MessagePersisted";
	const messageEvents = (domain: SessionDomainApi, sessionId: SessionId) =>
		domain
			.events({ streamId: sessionId })
			.pipe(Stream.filter(isMessagePersisted));
	const userText = (record: StoredMessagePersistedEvent) =>
		record.event.contentJson === undefined
			? undefined
			: (JSON.parse(record.event.contentJson) as { text?: string }).text;
	const sendAndSettle = async (
		run: Parameters<Parameters<typeof withRuntime>[0]>[0],
		sessionId: SessionId,
		text: string,
	) => {
		await run(
			Effect.flatMap(store, (service) =>
				service.sendMessage(testCommandId("messages.send"), sessionId, text),
			),
		);
		const turnId = requireProviderTurnId(sessionId);
		await run(
			Effect.flatMap(SessionDomain, (domain) =>
				domain.dispatch({
					commandId: `test:settle:${sessionId}:${text}`,
					streamId: sessionId,
					command: {
						_tag: "SettleTurn",
						turnId,
						outcome: "completed",
						settledAt: Date.now(),
					},
				}),
			),
		);
	};

	it("resumes from sinceSequence with zero gaps or duplicates", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const id = initialSession.id;
			for (const text of ["m1", "m2", "m3"]) {
				await sendAndSettle(run, id, text);
			}

			const first = await run(
				Effect.flatMap(SessionDomain, (domain) =>
					Stream.runCollect(messageEvents(domain, id).pipe(Stream.take(3))),
				),
			);
			expect(first.map(userText)).toEqual(["m1", "m2", "m3"]);
			const sequences = first.map((e) => e.sequence);
			expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
			const cursor = sequences.at(-1) ?? 0;

			for (const text of ["m4", "m5"]) {
				await sendAndSettle(run, id, text);
			}

			const resumed = await run(
				Effect.flatMap(SessionDomain, (domain) =>
					Stream.runCollect(
						domain
							.events({ streamId: id, afterSequence: cursor })
							.pipe(Stream.filter(isMessagePersisted), Stream.take(2)),
					),
				),
			);
			expect(resumed.map(userText)).toEqual(["m4", "m5"]);
			expect(resumed.every((e) => e.sequence > cursor)).toBe(true);
		});
	});

	it("replays an accepted prompt after response loss without duplicating or disturbing a successor", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const id = initialSession.id;
			const commandId = testCommandId("messages.send.response-lost");
			const clientMessageId = MessageId.make("message-response-lost");
			await run(
				Effect.flatMap(store, (service) =>
					service.sendMessage(
						commandId,
						id,
						"accepted before disconnect",
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						clientMessageId,
					),
				),
			);
			const acceptedTurn = requireProviderTurnId(id);
			await run(
				Effect.flatMap(SessionDomain, (domain) =>
					domain.dispatch({
						commandId: "test:settle:response-lost",
						streamId: id,
						command: {
							_tag: "SettleTurn",
							turnId: acceptedTurn,
							outcome: "completed",
							settledAt: Date.now(),
						},
					}),
				),
			);

			const successorTurn = AgentTurnId.make(
				"turn-successor-after-response-loss",
			);
			await run(
				Effect.gen(function* () {
					const domain = yield* SessionDomain;
					const state = yield* ConversationState;
					yield* domain.dispatch({
						commandId: "test:start:successor-after-response-loss",
						streamId: id,
						command: {
							_tag: "StartTurn",
							turnId: successorTurn,
							startedAt: Date.now(),
						},
					});
					state.rememberActiveTurn(id, successorTurn);
				}),
			);

			await run(
				Effect.flatMap(store, (service) =>
					service.sendMessage(
						commandId,
						id,
						"accepted before disconnect",
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						MessageId.make("message-retry-placeholder"),
					),
				),
			);

			const evidence = await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const state = yield* ConversationState;
					const messages = yield* sql<{
						readonly id: string;
						readonly content_json: string;
					}>`
						SELECT id, content_json FROM messages
						WHERE session_id = ${id} AND role = 'user'
						ORDER BY sequence
					`;
					const receipts = yield* sql<{ readonly count: number }>`
						SELECT COUNT(*) AS count FROM command_receipts
						WHERE command_id = ${commandId}
					`;
					const head = yield* sql<{ readonly id: string }>`
						SELECT id FROM session_turns
						WHERE session_id = ${id} AND status IN ('starting', 'running')
						ORDER BY ordinal DESC LIMIT 1
					`;
					return {
						messages,
						receiptCount: receipts[0]?.count ?? 0,
						durableTurn: head[0]?.id ?? null,
						cachedTurn: state.activeTurn(id),
					};
				}),
			);
			expect(evidence.messages).toEqual([
				expect.objectContaining({
					id: clientMessageId,
					content_json: expect.stringContaining("accepted before disconnect"),
				}),
			]);
			expect(evidence.receiptCount).toBe(1);
			expect(evidence.durableTurn).toBe(successorTurn);
			expect(evidence.cachedTurn).toBe(successorTurn);
			expect(providerSentTexts).toEqual(["accepted before disconnect"]);
		});
	});

	it("delivers a row persisted after subscribe exactly once (live tail)", async () => {
		await withRuntime(async (run) => {
			const { initialSession } = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const id = initialSession.id;
			await sendAndSettle(run, id, "m1");

			const collected = await run(
				Effect.gen(function* () {
					const s = yield* store;
					const domain = yield* SessionDomain;
					const fiber = yield* Effect.forkChild(
						Stream.runCollect(messageEvents(domain, id).pipe(Stream.take(3))),
					);
					yield* s.sendMessage(testCommandId("messages.send"), id, "m2");
					const m2Turn = requireProviderTurnId(id);
					yield* domain.dispatch({
						commandId: "test:settle:m2",
						streamId: id,
						command: {
							_tag: "SettleTurn",
							turnId: m2Turn,
							outcome: "completed",
							settledAt: Date.now(),
						},
					});
					yield* s.sendMessage(testCommandId("messages.send"), id, "m3");
					return yield* Fiber.await(fiber).pipe(Effect.flatten);
				}),
			);
			expect(collected.map(userText)).toEqual(["m1", "m2", "m3"]);
			expect(new Set(collected.map((e) => e.eventId)).size).toBe(3);
		});
	});

	it("keeps two sessions' streams isolated while sharing the global sequence", async () => {
		await withRuntime(async (run) => {
			const makeSession = Effect.flatMap(store, (s) =>
				s.createChat({
					projectId: PROJECT_ID,
					providerId: "claude",
					model: "claude-opus-4-8",
				}),
			);
			const a = (await run(makeSession)).initialSession.id;
			const b = (await run(makeSession)).initialSession.id;

			await sendAndSettle(run, a, "a1");
			await sendAndSettle(run, b, "b1");
			await sendAndSettle(run, a, "a2");

			const forA = await run(
				Effect.flatMap(SessionDomain, (domain) =>
					Stream.runCollect(messageEvents(domain, a).pipe(Stream.take(2))),
				),
			);
			const forB = await run(
				Effect.flatMap(SessionDomain, (domain) =>
					Stream.runCollect(messageEvents(domain, b).pipe(Stream.take(1))),
				),
			);

			expect(forA.map(userText)).toEqual(["a1", "a2"]);
			expect(forB.map(userText)).toEqual(["b1"]);

			expect(forA[0]!.sequence).toBeLessThan(forB[0]!.sequence);
			expect(forB[0]!.sequence).toBeLessThan(forA[1]!.sequence);
		});
	});
});

describe("ConversationServices — fork & transcript export", () => {
	it("exportTranscript renders the user prompt as Markdown", async () => {
		await withRuntime(async (run) => {
			const chat = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "fix the bug",
					}),
				),
			);
			const md = await run(
				Effect.flatMap(store, (s) =>
					s.exportTranscript(chat.initialSession.id),
				),
			);
			expect(md).toContain("## User");
			expect(md).toContain("fix the bug");
		});
	});

	it("forks to a new tab in copy mode when the source has no resume cursor", async () => {
		await withRuntime(async (run) => {
			const chat = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "hello",
					}),
				),
			);
			const sourceId = chat.initialSession.id;
			const messages = await run(
				Effect.flatMap(store, (s) => s.listMessages(sourceId)),
			);
			const userMsgId = messages[0]!.id;

			const result = await run(
				Effect.flatMap(store, (s) =>
					s.forkSession({
						sourceSessionId: sourceId,
						fromMessageId: userMsgId,
						destination: "tab",
					}),
				),
			);

			expect(result.forkMode).toBe("copy");

			expect(result.session.chatId).toBe(chat.chat.id);
			expect(result.session.id).not.toBe(sourceId);
			expect(result.session.forkedFromSessionId).toBe(sourceId);
			expect(result.session.forkedFromMessageId).toBe(userMsgId);
			expect(result.session.providerThread).toBeNull();

			expect(providerStartInputs.at(-1)?.forkFromResume ?? false).toBe(false);

			const forked = await run(
				Effect.flatMap(store, (s) => s.listMessages(result.session.id)),
			);
			expect(forked.map((m) => m.content)).toMatchObject([
				{ _tag: "user", text: "hello" },
			]);
		});
	});

	for (const action of [
		"cancel",
		"cancel-before-session",
		"delete-session",
		"delete-chat",
	] as const)
		it(`does not resurrect a partial fork after ${action}`, async () => {
			await withRuntime(async (run) => {
				const source = await run(
					Effect.flatMap(store, (service) =>
						service.createChat({
							projectId: PROJECT_ID,
							providerId: "claude",
							model: "claude-opus-4-8",
						}),
					),
				);
				const history = await run(
					Effect.flatMap(store, (service) =>
						service.importExternalMessages(source.initialSession.id, [
							{ _tag: "user", text: "Frozen source" },
						]),
					),
				);
				const destination = SessionId.make("cancelled-partial-fork");
				const input = {
					commandId: "cancelled-fork-command",
					initialSessionId: destination,
					sourceSessionId: source.initialSession.id,
					fromMessageId: history[0]!.id,
					destination: "tab" as const,
				};
				await run(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						if (action === "cancel-before-session")
							yield* sql`CREATE TRIGGER fail_cancelled_fork BEFORE INSERT ON sessions WHEN NEW.id='cancelled-partial-fork' BEGIN SELECT RAISE(ABORT,'creation unavailable'); END`;
						else
							yield* sql`CREATE TRIGGER fail_cancelled_fork BEFORE INSERT ON messages WHEN NEW.session_id='cancelled-partial-fork' BEGIN SELECT RAISE(ABORT,'import unavailable'); END`;
					}),
				);
				await expect(
					run(Effect.flatMap(store, (service) => service.forkSession(input))),
				).rejects.toBeDefined();
				const pending = await run(
					Effect.flatMap(store, (service) =>
						service.forkConstructions(source.initialSession.id),
					),
				);
				expect(pending).toMatchObject([
					{ sessionId: destination, state: "failed" },
				]);
				await run(
					Effect.gen(function* () {
						const service = yield* store;
						if (action === "cancel" || action === "cancel-before-session") {
							yield* service.cancelFork(source.initialSession.id, destination);
							yield* service.cancelFork(source.initialSession.id, destination);
						} else if (action === "delete-session")
							yield* service.deleteSession(destination);
						else yield* service.deleteChat(source.chat.id);
					}),
				);
				await run(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						yield* sql`DROP TRIGGER fail_cancelled_fork`;
					}),
				);
				await expect(
					run(Effect.flatMap(store, (service) => service.forkSession(input))),
				).rejects.toBeDefined();
				const evidence = await run(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						return {
							sessions:
								yield* sql`SELECT id FROM sessions WHERE id=${destination}`,
							pending:
								yield* sql`SELECT session_id FROM session_fork_constructions WHERE completed_at IS NULL`,
							cancelled:
								yield* sql`SELECT cancelled_at FROM session_fork_constructions WHERE session_id=${destination} AND cancelled_at IS NOT NULL`,
						};
					}),
				);
				expect(evidence.sessions).toHaveLength(0);
				expect(evidence.pending).toHaveLength(0);
				expect(evidence.cancelled).toHaveLength(1);
			});
		});

	it("recovers a partial fork before admitting a turn and supplies the frozen context", async () => {
		await withRuntime(async (run) => {
			const source = await run(
				Effect.flatMap(store, (service) =>
					service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					}),
				),
			);
			const history = await run(
				Effect.flatMap(store, (service) =>
					service.importExternalMessages(source.initialSession.id, [
						{ _tag: "user", text: "Preserve this decision." },
						{ _tag: "assistant", text: "Use the durable queue." },
					]),
				),
			);
			const sessionId = SessionId.make("fork-interrupted-import");
			const input = {
				commandId: "fork-retry",
				initialSessionId: sessionId,
				sourceSessionId: source.initialSession.id,
				fromMessageId: history[1]!.id,
				destination: "tab" as const,
			};
			await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`CREATE TRIGGER fail_fork_import BEFORE INSERT ON messages WHEN NEW.session_id='fork-interrupted-import' AND NEW.kind='assistant' BEGIN SELECT RAISE(ABORT, 'interrupted import'); END`;
				}),
			);
			await expect(
				run(Effect.flatMap(store, (service) => service.forkSession(input))),
			).rejects.toBeDefined();
			await expect(
				run(
					Effect.flatMap(store, (service) =>
						service.sendMessage("early-fork-send", sessionId, "Too early"),
					),
				),
			).rejects.toBeDefined();
			expect(providerSentTexts).not.toContain("Too early");
			await run(
				Effect.gen(function* () {
					const service = yield* store;
					yield* service.importExternalMessages(source.initialSession.id, [
						{ _tag: "assistant", text: "Later source text must not leak." },
					]);
					const sql = yield* SqlClient.SqlClient;
					yield* sql`DROP TRIGGER fail_fork_import`;
				}),
			);
			await run(
				Effect.flatMap(store, (service) =>
					service.retryFork(source.initialSession.id, sessionId),
				),
			);
			await expect
				.poll(() =>
					run(
						Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient;
							const rows = yield* sql<{
								completed_at: number | null;
							}>`SELECT completed_at FROM session_fork_constructions WHERE session_id=${sessionId}`;
							return rows[0]?.completed_at !== null;
						}),
					),
				)
				.toBe(true);
			const replay = await run(
				Effect.flatMap(store, (service) => service.forkSession(input)),
			);
			expect(replay.session.id).toBe(sessionId);
			const copied = await run(
				Effect.flatMap(store, (service) => service.listMessages(sessionId)),
			);
			expect(copied.map((message) => message.content)).toMatchObject([
				{ _tag: "user", text: "Preserve this decision." },
				{ _tag: "assistant", text: "Use the durable queue." },
			]);
			await run(
				Effect.flatMap(store, (service) =>
					service.sendMessage("continue-fork", sessionId, "Implement it"),
				),
			);
			expect(providerSentTexts.at(-1)).toContain("Preserve this decision.");
			expect(providerSentTexts.at(-1)).toContain("Use the durable queue.");
			expect(providerSentTexts.at(-1)).not.toContain("Later source text");
			expect(providerSentTexts.at(-1)).toContain(
				"Current user request:\nImplement it",
			);
		});
	});

	it("finishes a frozen fork after replacing the runtime without rereading its source", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-fork-restart-"));
		const dbPath = join(directory, "test.sqlite");
		let runtime = makeRuntime(dbPath);
		const run = <A>(effect: Effect.Effect<A, unknown, unknown>) =>
			runtime.runPromise(effect as Effect.Effect<A, unknown, never>);
		const destination = SessionId.make("fork-restart-destination");
		try {
			await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const now = new Date().toISOString();
					yield* sql`INSERT INTO projects(id,path,name,created_at,updated_at) VALUES (${PROJECT_ID},${directory},'Restart',${now},${now})`;
				}),
			);
			const input = await run(
				Effect.gen(function* () {
					const service = yield* store;
					const source = yield* service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					});
					const messages = yield* service.importExternalMessages(
						source.initialSession.id,
						[
							{ _tag: "user", text: "Original frozen context" },
							{ _tag: "assistant", text: "Original answer" },
						],
					);
					const sql = yield* SqlClient.SqlClient;
					yield* sql`CREATE TRIGGER pause_fork BEFORE INSERT ON messages WHEN NEW.session_id='fork-restart-destination' AND NEW.kind='assistant' BEGIN SELECT RAISE(ABORT,'process stopped'); END`;
					return {
						commandId: "fork-restart-command",
						initialSessionId: destination,
						sourceSessionId: source.initialSession.id,
						fromMessageId: messages[1]!.id,
						destination: "chat" as const,
					};
				}),
			);
			await expect(
				run(Effect.flatMap(store, (service) => service.forkSession(input))),
			).rejects.toBeDefined();
			await runtime.dispose();
			runtime = makeRuntime(dbPath, false);
			await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`DROP TRIGGER pause_fork`;

					yield* sql`DELETE FROM messages WHERE session_id=${input.sourceSessionId}`;
				}),
			);
			await expect
				.poll(() =>
					run(
						Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient;
							const rows = yield* sql<{
								completed_at: number | null;
							}>`SELECT completed_at FROM session_fork_constructions WHERE session_id=${destination}`;
							return typeof rows[0]?.completed_at === "number";
						}),
					),
				)
				.toBe(true);
			const result = await run(
				Effect.flatMap(store, (service) => service.forkSession(input)),
			);
			expect(result.session.id).toBe(destination);
			await run(
				Effect.flatMap(store, (service) =>
					service.sendMessage("fork-restart-send", destination, "Continue"),
				),
			);
			expect(providerSentTexts.at(-1)).toContain("Original frozen context");
			expect(providerSentTexts.at(-1)).toContain("Original answer");
			const copied = await run(
				Effect.flatMap(store, (service) => service.listMessages(destination)),
			);
			expect(
				copied.filter((message) => message.id.startsWith("fork:")),
			).toHaveLength(2);
		} finally {
			await runtime.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("merges only new fork context into the parent's next turn and replays one receipt", async () => {
		await withRuntime(async (run) => {
			const { parent, child } = await run(
				Effect.gen(function* () {
					const service = yield* store;
					const parent = (yield* service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					})).initialSession;
					const base = yield* service.importExternalMessages(parent.id, [
						{ _tag: "user", text: "Original base history" },
					]);
					const child = (yield* service.forkSession({
						commandId: "merge-child-fork",
						sourceSessionId: parent.id,
						fromMessageId: base[0]!.id,
						destination: "tab",
					})).session;
					yield* service.importExternalMessages(child.id, [
						{ _tag: "assistant", text: "Child discovered the fix" },
					]);
					return { parent, child };
				}),
			);
			await run(
				Effect.flatMap(store, (service) =>
					service.sendMessage(
						"parent-existing-turn",
						parent.id,
						"Existing work",
					),
				),
			);
			const merged = await run(
				Effect.flatMap(store, (service) =>
					service.mergeBack({ commandId: "merge-once", sessionId: child.id }),
				),
			);
			expect(merged.targetSessionId).toBe(parent.id);
			expect(merged.firstTurnId).toBeNull();
			const replay = await run(
				Effect.flatMap(store, (service) =>
					service.mergeBack({ commandId: "merge-once", sessionId: child.id }),
				),
			);
			expect(replay).toEqual(merged);
			expect(providerSentTexts.at(-1)).toBe("Existing work");
			await run(
				Effect.gen(function* () {
					const domain = yield* SessionDomain;
					const attempt = yield* domain.activeAttempt(parent.id);
					if (attempt === null) throw new Error("Missing parent turn");
					yield* domain.dispatch({
						commandId: "settle-existing-parent",
						streamId: parent.id,
						command: {
							_tag: "SettleTurn",
							turnId: attempt.turnId,
							outcome: "completed",
							settledAt: Date.now(),
						},
					});
				}),
			);
			await run(
				Effect.flatMap(store, (service) =>
					service.sendMessage("parent-next-turn", parent.id, "Use the result"),
				),
			);
			expect(providerSentTexts.at(-1)).toContain("Child discovered the fix");
			expect(providerSentTexts.at(-1)).not.toContain("Original base history");
			const links = await run(
				Effect.flatMap(store, (service) => service.contextLinks(parent.id)),
			);
			expect(links).toHaveLength(1);
			expect(links[0]?.firstTurnId).not.toBeNull();
			const history = await run(
				Effect.flatMap(store, (service) => service.listMessages(parent.id)),
			);
			expect(
				history.filter((message) =>
					message.id.startsWith("context-link-message:"),
				),
			).toHaveLength(1);
			await expect(
				run(
					Effect.flatMap(store, (service) =>
						service.mergeBack({
							commandId: "merge-no-delta",
							sessionId: child.id,
						}),
					),
				),
			).rejects.toMatchObject({ _tag: "SessionContextError" });
		});
	});

	it("rolls back a merge message and receipt when its durable handoff cannot commit", async () => {
		await withRuntime(async (run) => {
			const { parent, child } = await run(
				Effect.gen(function* () {
					const service = yield* store;
					const parent = (yield* service.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
					})).initialSession;
					const base = yield* service.importExternalMessages(parent.id, [
						{ _tag: "user", text: "Base" },
					]);
					const child = (yield* service.forkSession({
						sourceSessionId: parent.id,
						fromMessageId: base[0]!.id,
						destination: "tab",
					})).session;
					yield* service.importExternalMessages(child.id, [
						{ _tag: "assistant", text: "Delta" },
					]);
					const sql = yield* SqlClient.SqlClient;
					yield* sql`CREATE TRIGGER fail_context_link BEFORE INSERT ON session_context_links BEGIN SELECT RAISE(ABORT,'link unavailable'); END`;
					return { parent, child };
				}),
			);
			await expect(
				run(
					Effect.flatMap(store, (service) =>
						service.mergeBack({
							commandId: "merge-failure-retry",
							sessionId: child.id,
						}),
					),
				),
			).rejects.toMatchObject({ _tag: "SessionContextError" });
			expect(
				(
					await run(
						Effect.flatMap(store, (service) => service.listMessages(parent.id)),
					)
				).filter((message) => message.id.startsWith("context-link-message:")),
			).toHaveLength(0);
			await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`DROP TRIGGER fail_context_link`;
				}),
			);
			await run(
				Effect.flatMap(store, (service) =>
					service.mergeBack({
						commandId: "merge-failure-retry",
						sessionId: child.id,
					}),
				),
			);
			expect(
				(
					await run(
						Effect.flatMap(store, (service) => service.listMessages(parent.id)),
					)
				).filter((message) => message.id.startsWith("context-link-message:")),
			).toHaveLength(1);
		});
	});

	it("latestPlan returns null for a session with no proposed plan", async () => {
		await withRuntime(async (run) => {
			const chat = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "hello",
					}),
				),
			);
			const plan = await run(
				Effect.flatMap(store, (s) => s.latestPlan(chat.initialSession.id)),
			);
			expect(plan).toBeNull();
		});
	});

	it("latestPlan returns a native ExitPlanMode plan", async () => {
		await withRuntime(async (run) => {
			const chat = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "plan it",
					}),
				),
			);
			await run(
				Effect.flatMap(store, (s) =>
					s.importExternalMessages(chat.initialSession.id, [
						{
							_tag: "tool_use",
							itemId: "plan-tool" as never,
							tool: "ExitPlanMode",
							input: { plan: "# Native plan" },
						},
					]),
				),
			);
			const plan = await run(
				Effect.flatMap(store, (s) => s.latestPlan(chat.initialSession.id)),
			);
			expect(plan).toBe("# Native plan");
		});
	});

	it("latestPlan returns tagged assistant Markdown", async () => {
		await withRuntime(async (run) => {
			const chat = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "codex",
						model: "gpt-5.5",
						initialPrompt: "plan it",
					}),
				),
			);
			await run(
				Effect.flatMap(store, (s) =>
					s.importExternalMessages(chat.initialSession.id, [
						{
							_tag: "assistant",
							text: "<proposed_plan>\n# Codex plan\n</proposed_plan>",
						},
					]),
				),
			);
			const plan = await run(
				Effect.flatMap(store, (s) => s.latestPlan(chat.initialSession.id)),
			);
			expect(plan).toBe("# Codex plan");
		});
	});

	it("latestPlan recognizes an older unmarked Codex plan awaiting feedback", async () => {
		await withRuntime(async (run) => {
			const chat = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "codex",
						model: "gpt-5.5",
						initialPrompt: "plan it",
						permissionMode: "plan",
					}),
				),
			);
			await run(
				Effect.flatMap(store, (s) =>
					s.importExternalMessages(chat.initialSession.id, [
						{ _tag: "assistant", text: "# Existing Codex plan" },
					]),
				),
			);
			const plan = await run(
				Effect.flatMap(store, (s) => s.latestPlan(chat.initialSession.id)),
			);
			expect(plan).toBe("# Existing Codex plan");
		});
	});

	it("forks to a brand-new sidebar chat", async () => {
		await withRuntime(async (run) => {
			const chat = await run(
				Effect.flatMap(store, (s) =>
					s.createChat({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						initialPrompt: "hello",
					}),
				),
			);
			const messages = await run(
				Effect.flatMap(store, (s) => s.listMessages(chat.initialSession.id)),
			);
			const result = await run(
				Effect.flatMap(store, (s) =>
					s.forkSession({
						sourceSessionId: chat.initialSession.id,
						fromMessageId: messages[0]!.id,
						destination: "chat",
					}),
				),
			);
			expect(result.chat.id).not.toBe(chat.chat.id);
			expect(result.session.chatId).toBe(result.chat.id);
		});
	});

	it("forks with real provider memory at the conversation tail", async () => {
		await withRuntime(async (run) => {
			const chat = await run(
				Effect.flatMap(store, (s) =>
					s.continueExternalThread({
						projectId: PROJECT_ID,
						providerId: "claude",
						model: "claude-opus-4-8",
						title: "Existing thread",
						providerThread: {
							nativeThreadId: "claude-session-xyz",
							nativeHeadId:
								"claude-assistant:native-uuid:message-native%3Atext%3A0",
						},
					}),
				),
			);
			const sourceId = chat.initialSession.id;

			await run(
				Effect.flatMap(store, (s) =>
					s.importExternalMessages(sourceId, [
						{
							_tag: "assistant",
							itemId: AgentItemId.make("message-native:text:0"),
							text: "Stable native point",
						},
					]),
				),
			);
			const messages = await run(
				Effect.flatMap(store, (s) => s.listMessages(sourceId)),
			);
			const tailId = messages.at(-1)!.id;
			const startsBeforeFork = providerStartInputs.length;

			const result = await run(
				Effect.flatMap(store, (s) =>
					s.forkSession({
						sourceSessionId: sourceId,
						fromMessageId: tailId,
						destination: "tab",
					}),
				),
			);

			expect(result.forkMode).toBe("resume");
			expect(result.session.providerThread?.nativeThreadRef.nativeId).toBe(
				"claude-session-xyz",
			);
			expect(result.session.providerThread?.provider).toBe("claude");

			expect(providerStartInputs).toHaveLength(startsBeforeFork);
			await run(
				Effect.flatMap(store, (s) =>
					s.sendMessage(
						testCommandId("messages.send"),
						result.session.id,
						"continue from this point",
					),
				),
			);
			await expect
				.poll(() => providerStartInputs.length)
				.toBe(startsBeforeFork + 1);

			expect(providerStartInputs.at(-1)?.forkFromResume).toBe(true);
			expect(providerStartCursors.at(-1)).toBe("claude-session-xyz");
		});
	});
});
