import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import type { OrchestrationSessionTools } from "@zuse/agents/drivers/orchestration-tools";
import type {
	AgentEvent,
	AgentSessionId,
	AutonomyLevel,
	FolderId,
	StartSessionInput,
	WorktreeId,
} from "@zuse/contracts";
import {
	AgentSessionNotFoundError,
	AgentSessionStartError,
	AgentTurnId,
	ChatId,
	ComposerInput,
	defaultModelFor,
	MessageId,
	RepositorySettings,
	SessionId,
	Worktree,
	WorktreeCheckpointError,
} from "@zuse/contracts";
import type { SessionEvent } from "@zuse/domain/core/events";
import { ChatDomain } from "@zuse/domain/engine/chat-domain";
import type { StoredEvent } from "@zuse/domain/engine/dispatch";
import {
	SessionDomain,
	type SessionDomainApi,
} from "@zuse/domain/engine/session-domain";
import { SqlSessionQueries } from "@zuse/domain/queries/sql-session-queries";
import { GitService } from "@zuse/git/git-service";
import { WorktreeService } from "@zuse/git/worktree-service";
// Exercise ConversationServicesLive through the same node:sqlite client layer used by
// the production Node runtime.
import { layer as sqliteLayer } from "@zuse/sqlite";
import {
	Context,
	Effect,
	Fiber,
	Layer,
	ManagedRuntime,
	Schedule,
	Stream,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigStoreService } from "../../src/config-store/services/config-store-service.ts";
import { ConversationState } from "../../src/conversation/core/conversation-state.ts";
import { ConversationServicesLive } from "../../src/conversation/layers/conversation-services.ts";
import {
	ChatService,
	type ConversationOperations,
	MessageService,
	QueueService,
	SessionService,
	TranscriptService,
} from "../../src/conversation/services/conversation-services.ts";
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
import { NdjsonLogger } from "../../src/persistence/ndjson-logger.ts";
import { ProviderService } from "../../src/provider/services/provider-service.ts";
import { TitleGenerator } from "../../src/provider/title-generator.ts";
import { PtyService } from "../../src/pty/services/pty-service.ts";
import { RelayActivityPublisher } from "../../src/relay/activity-publisher.ts";
import { RepositorySettingsService } from "../../src/repository-settings/services/repository-settings-service.ts";

const PROJECT_ID = "proj-test" as FolderId;
const TEST_WORKTREE_ID = "wt-pikachu" as WorktreeId;
const TEST_WORKTREE_PATH = "/tmp/project/.memo/pikachu";

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

/**
 * Scripted provider events the stub replays on `events()` for the next
 * created session. The ConversationServices boot path subscribes to this stream and
 * persists each renderable event — letting us assert the full
 * provider-event → messages-table pipeline without a real agent CLI.
 */
let scriptedEvents: ReadonlyArray<AgentEvent> = [];
let providerStartInputs: StartSessionInput[] = [];
let providerStartCursors: Array<string | null> = [];
let providerSentTexts: string[] = [];
let providerSendAttempts = 0;
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
let failProviderSend = false;
let providerStartBarrier: Promise<void> | null = null;
let testAutonomyLevel: AutonomyLevel = "approval-gated";
let createdWorktreeCount = 0;
let createdWorktrees = new Map<string, Worktree>();
let archivedWorktreeIds = new Set<string>();
let restoredWorktreeCount = 0;
let archiveWorktreeBarrier: Promise<void> | null = null;
let archiveWorktreeStarts = 0;
let archiveWorktreeFailure: "git-missing" | null = null;

const deferred = <A>() => {
	let resolve!: (value: A) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<A>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

/** A no-op ProviderService: starts/sends succeed; events replay the script. */
const StubProviderLive = Layer.succeed(ProviderService, {
	availability: () => Effect.succeed([]),
	start: (input, resumeCursor, _runtimeMode, orchestrationTools) =>
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
					reason: "scripted start failure",
				});
			}
			return {
				sessionId: input.sessionId ?? ("stub" as AgentSessionId),
			};
		}),
	send: (sessionId, turnId, text) =>
		Effect.sync(() => {
			providerSendAttempts += 1;
			providerTurnIds.set(sessionId, turnId);
		}).pipe(
			Effect.andThen(
				failProviderSend
					? Effect.fail(new AgentSessionNotFoundError({ sessionId }))
					: Effect.sync(() => {
							providerSentTexts.push(text);
						}),
			),
		),
	interrupt: () => Effect.void,
	close: () => Effect.void,
	events: (sessionId) =>
		Stream.suspend(() =>
			Stream.fromIterable(
				scriptedEvents.map((event) => ({
					scope: "turn" as const,
					turnId:
						providerTurnIds.get(sessionId) ?? AgentTurnId.make("test-turn"),
					event,
				})),
			),
		),
	setCredential: () => Effect.void,
	setPermissionMode: () => Effect.void,
	answerQuestion: () => Effect.void,
	respondToPlan: (sessionId) =>
		Effect.fail(new AgentSessionNotFoundError({ sessionId })),
	getGoal: () => Effect.succeed(null),
	setGoal: () => Effect.die("not used"),
	clearGoal: () => Effect.void,
});

let testWorktree = Worktree.make({
	id: TEST_WORKTREE_ID,
	projectId: PROJECT_ID,
	path: TEST_WORKTREE_PATH,
	name: "pikachu",
	branch: "pikachu",
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
	updateBranch: () => Effect.void,
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
	finishArchiveRemoval: () => Effect.void,
	remove: () => Effect.void,
	rerunSetup: () => Effect.die("not used"),
	setupStream: () => Stream.die("not used"),
	startRun: () => Effect.die("not used"),
	restore: (snapshot) =>
		Effect.sync(() => {
			restoredWorktreeCount += 1;
			archivedWorktreeIds.delete(snapshot.id as string);
			return snapshot.id === TEST_WORKTREE_ID
				? testWorktree
				: (createdWorktrees.get(snapshot.id as string) ?? testWorktree);
		}),
});

// The first-message auto-namer may fire for chats with a worktree. Tests here
// do not exercise branch naming, so these stubs only satisfy the layer graph.
const StubGitLive = Layer.succeed(GitService, {
	log: () => Effect.die("not used"),
	status: () => Effect.die("not used"),
	branches: () => Effect.die("not used"),
	switchBranch: () => Effect.die("not used"),
	renameBranch: () => Effect.die("not used"),
	getUserName: () => Effect.succeed(""),
	subscribeHeadChanges: () => Stream.die("not used"),
	origin: () => Effect.die("not used"),
	prState: () => Effect.die("not used"),
	prDetails: () => Effect.die("not used"),
	createReviewComment: () => Effect.succeed({ url: null }),
	reviewIdentity: () => Effect.succeed(null),
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
	resolveConflict: () => Effect.die("not used"),
	mergePr: () => Effect.die("not used"),
	markReady: () => Effect.die("not used"),
	init: () => Effect.die("not used"),
	revertFile: () => Effect.die("not used"),
	revertAll: () => Effect.die("not used"),
	restoreFileToBase: () => Effect.die("not used"),
	diffStat: () => Effect.die("not used"),
	fixFailingChecks: () => Effect.die("not used"),
});

const StubTitleGeneratorLive = Layer.succeed(TitleGenerator, {
	generate: () => Effect.die("not used"),
});

const StubConfigStoreLive = Layer.succeed(ConfigStoreService, {
	getSettings: () =>
		Effect.succeed({
			defaultAutonomyLevel: testAutonomyLevel,
			defaultModelByProvider: {
				claude: defaultModelFor("claude"),
				codex: defaultModelFor("codex"),
				grok: defaultModelFor("grok"),
				cursor: defaultModelFor("cursor"),
				gemini: defaultModelFor("gemini"),
				opencode: defaultModelFor("opencode"),
			},
		} as never),
	updateSettings: () => Effect.die("not used"),
	settingsChanges: () => Stream.die("not used"),
	migrateLocalStorage: () => Effect.die("not used"),
	getKeybindings: () => Effect.die("not used"),
	replaceKeybindings: () => Effect.die("not used"),
	keybindingsChanges: () => Stream.die("not used"),
});

const StubRelayActivityPublisherLive = Layer.succeed(RelayActivityPublisher, {
	publish: () => Effect.void,
});

/** Chat archive cleanup is out of scope for ConversationServices persistence tests. */
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
				fileIncludeGlobs: "",
				mcpDisabledServers: [],
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
				fileIncludeGlobs: patch.fileIncludeGlobs ?? "",
				mcpDisabledServers: patch.mcpDisabledServers ?? [],
			}),
		),
});

/** PTYs are only touched during worktree cleanup; these tests use no worktrees. */
const StubPtyLive = Layer.succeed(PtyService, {
	open: () => Effect.die("not used"),
	write: () => Effect.die("not used"),
	resize: () => Effect.die("not used"),
	close: () => Effect.die("not used"),
	closeByCwdPrefix: () => Effect.void,
	subscribe: () => Stream.die("not used"),
});

/** NdjsonLogger writes audit lines; in tests we swallow them. */
const StubNdjsonLive = Layer.succeed(NdjsonLogger, {
	append: () => Effect.void,
	close: () => Effect.void,
});

// Run every numbered migration in order against the generic SqlClient. We run
// them directly instead of via the node `SqliteMigrator` so the schema builds
// on top of the bun client too — a fresh test DB needs no migration tracking.
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
	],
	{ discard: true },
);

const makeRuntime = (dbPath: string, migrate = true) => {
	const SqlLive = sqliteLayer({ filename: dbPath });
	// Run migrations during layer build, and re-export SqlClient downstream.
	const Migrated = migrate
		? Layer.effectDiscard(runAllMigrations).pipe(Layer.provideMerge(SqlLive))
		: SqlLive;
	const DomainLive = SessionDomain.layer.pipe(
		Layer.provide(Migrated),
		Layer.provide(NodeServices.layer),
	);
	const ChatDomainLive = ChatDomain.layer.pipe(
		Layer.provide(Migrated),
		Layer.provide(NodeServices.layer),
	);
	const SessionQueriesLive = SqlSessionQueries.layer.pipe(
		Layer.provide(Migrated),
	);
	const ConversationLayer = ConversationServicesLive.pipe(
		Layer.provideMerge(ConversationState.layer),
		Layer.provide(StubProviderLive),
		Layer.provide(StubWorktreeLive),
		Layer.provide(StubRepositorySettingsLive),
		Layer.provide(StubPtyLive),
		Layer.provide(StubNdjsonLive),
		Layer.provide(StubGitLive),
		Layer.provide(StubTitleGeneratorLive),
		Layer.provide(StubConfigStoreLive),
		Layer.provide(StubRelayActivityPublisherLive),
		Layer.provideMerge(DomainLive),
		Layer.provide(ChatDomainLive),
		Layer.provide(SessionQueriesLive),
		Layer.provide(NodeServices.layer),
		// provideMerge (not provide) so SqlClient stays in the runtime context —
		// the test seeds the `projects` row through it directly.
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
		// Seed the project row through the runtime's own SqlClient.
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
            (id, project_id, path, name, branch, base_branch, created_at)
          VALUES
            (${TEST_WORKTREE_ID}, ${PROJECT_ID}, ${testWorktree.path},
             ${testWorktree.name}, ${testWorktree.branch},
             ${testWorktree.baseBranch}, ${now}),
			(${"wt-created-1"}, ${PROJECT_ID},
			 ${join(dirname(testWorktree.path), "created-1")}, ${"created-1"},
             ${"created-1"}, ${"origin/main"}, ${now})
        `;
			}),
		);
		return await fn(run);
	} finally {
		await runtime.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
};

const store = TestConversation;

beforeEach(() => {
	providerStartInputs = [];
	providerStartCursors = [];
	providerSentTexts = [];
	providerTurnIds.clear();
	providerSendAttempts = 0;
	providerStartOrchestrationTools = [];
	failProviderStart = false;
	failProviderSend = false;
	providerStartBarrier = null;
	testAutonomyLevel = "approval-gated";
	createdWorktreeCount = 0;
	createdWorktrees = new Map();
	archivedWorktreeIds = new Set();
	restoredWorktreeCount = 0;
	archiveWorktreeBarrier = null;
	archiveWorktreeStarts = 0;
	archiveWorktreeFailure = null;
});

describe("ConversationServices migrations", () => {
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
	it("acknowledges creation before provider startup failure becomes durable", async () => {
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
			expect(created.initialSession.status).toBe("booting");
			await expect
				.poll(() =>
					run(
						Effect.flatMap(store, (service) =>
							service.getSession(created.initialSession.id),
						),
					),
				)
				.toMatchObject({ status: "error" });
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
			// Let the provider event pump finish its idle transition before creating
			// the synthetic durable turn this test is specifically exercising.
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
						service.sendMessage(initialSession.id, "must not overlap"),
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

	it("starts providers through the durable provider-start reactor", async () => {
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
			await expect.poll(() => providerStartInputs.length).toBe(1);
			await expect
				.poll(() =>
					run(
						Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient;
							return yield* sql<{ readonly effect_id: string }>`
								SELECT effect_id FROM reactor_effect_receipts
								WHERE effect_id LIKE 'reactor:provider-start:%'
							`;
						}),
					),
				)
				.toHaveLength(1);
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
					const cursor = yield* sql<{ readonly last_sequence: number }>`
            SELECT last_sequence FROM projector_cursors
            WHERE projector_name = 'reactor:provider-start'
          `;
					const receipts = yield* sql<{ readonly effect_id: string }>`
            SELECT effect_id FROM reactor_effect_receipts
            WHERE effect_id LIKE 'reactor:provider-start:%'
          `;
					return { events, cursor, receipts };
				}),
			);

			expect(providerStartInputs).toHaveLength(1);
			expect(evidence.events).toHaveLength(1);
			expect(
				JSON.parse(evidence.events[0]?.payload_json ?? "null"),
			).toMatchObject({
				_tag: "SessionCreated",
				providerStartJson: expect.any(String),
			});
			expect(evidence.cursor[0]?.last_sequence).toBeGreaterThan(0);
			expect(evidence.receipts).toHaveLength(1);
		});
	});

	it("stops providers through the durable provider-stop reactor", async () => {
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
					const receipts = yield* sql<{ readonly effect_id: string }>`
            SELECT effect_id FROM reactor_effect_receipts
            WHERE effect_id LIKE 'reactor:provider-stop:%'
          `;
					return { events, receipts };
				}),
			);

			expect(evidence.events.map(({ type }) => type)).toEqual([
				"ProviderStopRequested",
				"ProviderDetached",
			]);
			expect(evidence.receipts).toHaveLength(1);
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

			// Older workers reported a missing cwd as missing Git. Reading archive
			// jobs repairs that durable state so clients stop offering Force archive.
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
			).resolves.toEqual([]);
			await expect(
				run(
					Effect.flatMap(store, (service) =>
						service.getArchiveStatus(created.chat.id),
					),
				),
			).resolves.toMatchObject({
				status: "completed",
				phase: "directory-missing",
				error: null,
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
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(archiveWorktreeStarts).toBe(2);
			barrier.resolve();
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
			// Worktree deletion clears the SQL foreign key, but the session event
			// state still remembers the original id. This projection drift is the
			// production failure mode that previously routed restore into main.
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
			// The durable receipt precedes provider startup.
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
			expect(result.initialSession.status).toBe("booting");
			expect(result.initialMessage).toBeNull();
			const messages = await run(
				Effect.flatMap(store, (service) => service.listMessages(sessionId)),
			);
			expect(messages).toEqual([]);
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
				.poll(
					() =>
						providerStartInputs.find(
							(input) => input.sessionId === result.child.initialSession.id,
						)?.initialPrompt,
				)
				.toBe("do the spawned task");
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
				defaultModelFor("codex"),
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
			expect(child.model).toBe(defaultModelFor("codex"));
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
					model: defaultModelFor("codex"),
				});
			const replayed = await run(
				Effect.flatMap(store, (s) =>
					s.streamChatChanges(PROJECT_ID).pipe(
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
					const streamFiber = yield* s
						.streamChatChanges(PROJECT_ID)
						.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
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
						resumeCursor: "claude-session-123",
						resumeStrategy: "claude-session-id",
					}),
				),
			);

			expect(result.chat.title).toBe("Existing Claude thread");
			expect(result.initialSession.cursor).toBe("claude-session-123");
			expect(result.initialSession.resumeStrategy).toBe("claude-session-id");
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
			await expect.poll(() => providerStartInputs.length).toBe(1);
			providerStartInputs = [];

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
            UPDATE sessions
            SET cursor = 'claude-main-cwd',
                resume_strategy = 'claude-session-id'
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
			expect(updated.cursor).toBeNull();
			expect(updated.resumeStrategy).toBe("none");
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
            UPDATE sessions
            SET cursor = 'claude-main-cwd',
                resume_strategy = 'claude-session-id'
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
			expect(updated.cursor).toBeNull();
			expect(updated.resumeStrategy).toBe("none");
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

	it("settles a stale plan interaction when its provider handle is gone", async () => {
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
			expect(messages.at(-1)?.content).toMatchObject({
				_tag: "tool_result",
				itemId: toolCallId,
				isError: true,
				output: {
					outcome: "cancelled",
					reason: "provider_session_unavailable",
				},
			});
		});
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
						s.renameSession(id, "Renamed"),
						s.setRuntimeMode(id, "full-access"),
						s.setPermissionMode(id, "plan"),
					]),
				),
			);

			const got = await run(Effect.flatMap(store, (s) => s.getSession(id)));
			expect(got.title).toBe("Renamed");
			expect(got.runtimeMode).toBe("full-access");
			expect(got.permissionMode).toBe("plan");
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

			await run(Effect.flatMap(store, (s) => s.sendMessage(id, "hello there")));

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
			// The row the renderer inserted optimistically and the persisted/echoed
			// row share the id, so the live stream dedupes against it.
			expect(user.some((m) => m.id === clientId)).toBe(true);
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
						s.addQueuedMessage(initialSession.id, first),
						s.addQueuedMessage(initialSession.id, second),
					]),
				),
			);
			expect(a.position).toBe(0);
			expect(b.position).toBe(1);

			await run(
				Effect.flatMap(store, (s) =>
					s.updateQueuedMessage(
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
					s.reorderQueuedMessages(initialSession.id, [b.id, a.id]),
				),
			);
			expect(reordered.map((item) => item.input.text)).toEqual([
				"second",
				"first edited",
			]);

			await run(
				Effect.flatMap(store, (s) =>
					s.deleteQueuedMessage(initialSession.id, b.id),
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
							initialSession.id,
							input,
							"q_client_optimistic",
						),
						service.addQueuedMessage(
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
					service.updateQueuedMessage(initialSession.id, held.id, held.input),
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
					yield* service.deleteQueuedMessage(initialSession.id, held.id);
					return yield* Effect.result(
						service.updateQueuedMessage(initialSession.id, held.id, held.input),
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
			expect(
				providerSentTexts.filter((text) => text === input.text),
			).toHaveLength(1);
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
					service.flushQueuedMessages(created.initialSession.id),
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
			expect(providerSentTexts).toEqual(["restore after failure"]);
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
					s.addQueuedMessage(initialSession.id, input),
				),
			);
			expect(queued.input.annotations).toEqual(input.annotations);

			await run(
				Effect.flatMap(store, (s) =>
					s.sendQueuedMessageNow(initialSession.id, queued.id),
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
					s.addQueuedMessage(initialSession.id, input),
				),
			);
			expect(queued.input.annotations).toEqual(input.annotations);
			expect(queued.input.attachments).toEqual(input.attachments);

			await run(
				Effect.flatMap(store, (s) =>
					s.sendQueuedMessageNow(initialSession.id, queued.id),
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
							initialSession.id,
							new ComposerInput({
								text: "queued one",
								attachments: [],
								fileRefs: [],
								skillRefs: [],
							}),
						),
						s.addQueuedMessage(
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
				Effect.flatMap(store, (s) => s.flushQueuedMessages(initialSession.id)),
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
				Effect.flatMap(store, (s) => s.flushQueuedMessages(initialSession.id)),
			);

			const queue = await run(
				Effect.flatMap(store, (s) => s.listQueuedMessages(initialSession.id)),
			);
			expect(queue.items.map((item) => item.input.text)).toEqual(["wait"]);
		});
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
			await expect
				.poll(() =>
					runFirst(
						Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient;
							return yield* sql<{ readonly effect_id: string }>`
								SELECT effect_id FROM reactor_effect_receipts
								WHERE effect_id LIKE 'reactor:provider-start:%'
							`;
						}),
					),
				)
				.toHaveLength(1);
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

			const interruptedTurnId = requireProviderTurnId(initialSession.id);
			await run(
				Effect.flatMap(store, (s) =>
					s.interruptSession(initialSession.id, interruptedTurnId),
				),
			);
			// A rapid second click can arrive after the first request has already
			// settled the exact turn. It must remain an idempotent success.
			await run(
				Effect.flatMap(store, (s) =>
					s.interruptSession(initialSession.id, interruptedTurnId),
				),
			);
			await run(
				Effect.flatMap(store, (s) => s.flushQueuedMessages(initialSession.id)),
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
							initialSession.id,
							new ComposerInput({
								text: "queued one",
								attachments: [],
								fileRefs: [],
								skillRefs: [],
							}),
						),
						s.addQueuedMessage(
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
						initialSession.id,
						requireProviderTurnId(initialSession.id),
					),
				),
			);

			await run(
				Effect.flatMap(store, (s) => s.resumeQueuedMessages(initialSession.id)),
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

	it("sendQueuedMessageNow and flush do not duplicate the same queued row", async () => {
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
							s.sendQueuedMessageNow(initialSession.id, item.id),
							s.flushQueuedMessages(initialSession.id),
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
							SELECT s.provider_event_cursor,
								(SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.kind = 'assistant') AS message_count
							FROM sessions s WHERE s.id = ${initialSession.id}
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

				// The event pump is a forked daemon — poll until the assistant row
				// lands (or give up after a bounded number of tries).
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
			Effect.flatMap(store, (service) => service.sendMessage(sessionId, text)),
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

			// First subscription: full replay of the three persisted rows.
			const first = await run(
				Effect.flatMap(SessionDomain, (domain) =>
					Stream.runCollect(messageEvents(domain, id).pipe(Stream.take(3))),
				),
			);
			expect(first.map(userText)).toEqual(["m1", "m2", "m3"]);
			const sequences = first.map((e) => e.sequence);
			expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
			const cursor = sequences.at(-1) ?? 0;

			// "Network drop": the first stream is gone; more rows land meanwhile.
			for (const text of ["m4", "m5"]) {
				await sendAndSettle(run, id, text);
			}

			// Resubscribe with the recorded cursor — exactly the delta, in order.
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

			// Subscribe past m1, then persist m2/m3 while the stream is live —
			// they must arrive via the tail, once each, in sequence order.
			const collected = await run(
				Effect.gen(function* () {
					const s = yield* store;
					const domain = yield* SessionDomain;
					const fiber = yield* Effect.forkChild(
						Stream.runCollect(messageEvents(domain, id).pipe(Stream.take(3))),
					);
					yield* s.sendMessage(id, "m2");
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
					yield* s.sendMessage(id, "m3");
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
			// Global cursor: b1 landed between a1 and a2.
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
			// Same chat (tab), new session, provenance recorded.
			expect(result.session.chatId).toBe(chat.chat.id);
			expect(result.session.id).not.toBe(sourceId);
			expect(result.session.forkedFromSessionId).toBe(sourceId);
			expect(result.session.forkedFromMessageId).toBe(userMsgId);
			expect(result.session.cursor).toBeNull();
			// No fork-of-transcript request to the provider in copy mode.
			expect(providerStartInputs.at(-1)?.forkFromResume ?? false).toBe(false);

			// The visible transcript up to the fork message was replayed.
			const forked = await run(
				Effect.flatMap(store, (s) => s.listMessages(result.session.id)),
			);
			expect(forked.map((m) => m.content)).toMatchObject([
				{ _tag: "user", text: "hello" },
			]);
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
						resumeCursor: "claude-session-xyz",
						resumeStrategy: "claude-session-id",
					}),
				),
			);
			const sourceId = chat.initialSession.id;
			// Add a user message so there is a tail to fork from.
			await run(
				Effect.flatMap(store, (s) => s.sendMessage(sourceId, "keep going")),
			);
			const messages = await run(
				Effect.flatMap(store, (s) => s.listMessages(sourceId)),
			);
			const tailId = messages.at(-1)!.id;

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
			expect(result.session.cursor).toBe("claude-session-xyz");
			expect(result.session.resumeStrategy).toBe("claude-session-id");
			// The driver was told to fork the resumed transcript.
			expect(providerStartInputs.at(-1)?.forkFromResume).toBe(true);
			expect(providerStartCursors.at(-1)).toBe("claude-session-xyz");
		});
	});
});
