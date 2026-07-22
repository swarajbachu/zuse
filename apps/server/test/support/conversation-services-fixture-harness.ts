import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import type {
	AgentEvent,
	AgentSessionId,
	FolderId,
	StartSessionInput,
	WorktreeId,
} from "@zuse/contracts";
import { AgentTurnId, RepositorySettings, Worktree } from "@zuse/contracts";
import { ChatDomain } from "@zuse/domain/engine/chat-domain";
import { SessionDomain } from "@zuse/domain/engine/session-domain";
import { SqlSessionQueries } from "@zuse/domain/queries/sql-session-queries";
import { GitService } from "@zuse/git/git-service";
import { WorktreeService } from "@zuse/git/worktree-service";
import { layer as sqliteLayer } from "@zuse/sqlite";
import {
	Context,
	Effect,
	Layer,
	ManagedRuntime,
	Schedule,
	Stream,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
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
import { Migration0021AuthTokens } from "../../src/persistence/migrations/0021_auth_tokens.ts";
import { Migration0022AttachmentAbsPath } from "../../src/persistence/migrations/0022_attachment_abs_path.ts";
import { Migration0023ChatLineage } from "../../src/persistence/migrations/0023_chat_lineage.ts";
import { Migration0024RemoteConnectState } from "../../src/persistence/migrations/0024_remote_connect_state.ts";
import { Migration0030CqrsEngine } from "../../src/persistence/migrations/0030_cqrs_engine.ts";
import { Migration0031BackfillRuns } from "../../src/persistence/migrations/0031_backfill_runs.ts";
import { Migration0032ReactorEffectReceipts } from "../../src/persistence/migrations/0032_reactor_effect_receipts.ts";
import { Migration0033ReactorEffectSteps } from "../../src/persistence/migrations/0033_reactor_effect_steps.ts";
import { Migration0034ToolEventLookup } from "../../src/persistence/migrations/0034_tool_event_lookup.ts";
import { Migration0038QueuedMessageReady } from "../../src/persistence/migrations/0038_queued_message_ready.ts";
import { Migration0039AuthTokenDevices } from "../../src/persistence/migrations/0039_auth_token_devices.ts";
import { Migration0041ChatArchiveJobs } from "../../src/persistence/migrations/0041_chat_archive_jobs.ts";
import { NdjsonLogger } from "../../src/persistence/ndjson-logger.ts";
import { ProviderService } from "../../src/provider/services/provider-service.ts";
import { TitleGenerator } from "../../src/provider/title-generator.ts";
import { PtyService } from "../../src/pty/services/pty-service.ts";
import { RelayActivityPublisher } from "../../src/relay/activity-publisher.ts";
import { RepositorySettingsService } from "../../src/repository-settings/services/repository-settings-service.ts";

export const FIXTURE_PROJECT_ID = "fixture-project" as FolderId;
const FIXTURE_WORKTREE_ID = "fixture-worktree" as WorktreeId;
const FIXTURE_PROJECT_PATH = "/tmp/zuse-fixture-project";
const FIXTURE_WORKTREE_PATH = "/tmp/zuse-fixture-project/.memo/worktree";

class TestConversation extends Context.Service<
	TestConversation,
	ConversationOperations
>()("test/FixtureConversation") {}

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

const renderableTags = new Set<AgentEvent["_tag"]>([
	"AssistantMessage",
	"Thinking",
	"ToolUse",
	"ToolResult",
	"SubagentSummary",
	"Error",
	"Interrupted",
	"ContextUsage",
	"UsageLimit",
]);

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
		Migration0021AuthTokens,
		Migration0022AttachmentAbsPath,
		Migration0023ChatLineage,
		Migration0024RemoteConnectState,
		Migration0030CqrsEngine,
		Migration0031BackfillRuns,
		Migration0032ReactorEffectReceipts,
		Migration0033ReactorEffectSteps,
		Migration0034ToolEventLookup,
		Migration0038QueuedMessageReady,
		Migration0039AuthTokenDevices,
		Migration0041ChatArchiveJobs,
	],
	{ discard: true },
);

const makeTestWorktree = () =>
	Worktree.make({
		id: FIXTURE_WORKTREE_ID,
		projectId: FIXTURE_PROJECT_ID,
		path: FIXTURE_WORKTREE_PATH,
		name: "fixture",
		branch: "fixture",
		baseBranch: "origin/main",
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		setupStatus: "succeeded",
		setupOutput: "",
		setupStartedAt: null,
		setupFinishedAt: null,
		pokemon: null,
	});

const makeRuntime = (
	dbPath: string,
	scriptedEvents: ReadonlyArray<AgentEvent>,
) => {
	const StubProviderLive = Layer.succeed(ProviderService, {
		availability: () => Effect.succeed([]),
		start: (input: StartSessionInput) =>
			Effect.succeed({
				sessionId: input.sessionId ?? ("fixture-session" as AgentSessionId),
			}),
		send: () => Effect.void,
		interrupt: () => Effect.void,
		close: () => Effect.void,
		events: () =>
			Stream.fromIterable(
				scriptedEvents.map((event) => ({
					scope: "turn" as const,
					turnId: AgentTurnId.make("fixture-turn"),
					event,
				})),
			),
		setCredential: () => Effect.void,
		setPermissionMode: () => Effect.void,
		answerQuestion: () => Effect.void,
		getGoal: () => Effect.succeed(null),
		setGoal: () => Effect.die("not used"),
		clearGoal: () => Effect.void,
	});

	const StubWorktreeLive = Layer.succeed(WorktreeService, {
		create: () => Effect.die("not used"),
		list: () => Effect.succeed([]),
		get: (worktreeId) =>
			Effect.succeed(
				worktreeId === FIXTURE_WORKTREE_ID ? makeTestWorktree() : null,
			),
		updateBranch: () => Effect.void,
		archive: (_worktreeId, recordCheckpoint) => {
			const outcome = {
				archiveCommit: "checkpoint-sha",
				checkpointCreated: false,
				archiveRef: null,
				archivedContextPath: null,
				branch: "fixture",
			};
			return recordCheckpoint === undefined
				? Effect.succeed(outcome)
				: recordCheckpoint(outcome).pipe(Effect.as(outcome));
		},
		finishArchiveRemoval: () => Effect.void,
		remove: () => Effect.void,
		rerunSetup: () => Effect.die("not used"),
		setupStream: () => Stream.die("not used"),
		startRun: () => Effect.die("not used"),
		restore: () => Effect.die("not used"),
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

	const StubPtyLive = Layer.succeed(PtyService, {
		open: () => Effect.die("not used"),
		write: () => Effect.die("not used"),
		resize: () => Effect.die("not used"),
		close: () => Effect.die("not used"),
		closeByCwdPrefix: () => Effect.void,
		subscribe: () => Stream.die("not used"),
	});

	const StubNdjsonLive = Layer.succeed(NdjsonLogger, {
		append: () => Effect.void,
		close: () => Effect.void,
	});

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
		getSettings: () => Effect.die("not used"),
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

	const SqlLive = sqliteLayer({ filename: dbPath });
	const Migrated = Layer.effectDiscard(runAllMigrations).pipe(
		Layer.provideMerge(SqlLive),
	);
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
		Layer.provide(ConversationState.layer),
		Layer.provide(StubProviderLive),
		Layer.provide(StubWorktreeLive),
		Layer.provide(StubRepositorySettingsLive),
		Layer.provide(StubPtyLive),
		Layer.provide(StubNdjsonLive),
		Layer.provide(StubGitLive),
		Layer.provide(StubTitleGeneratorLive),
		Layer.provide(StubConfigStoreLive),
		Layer.provide(StubRelayActivityPublisherLive),
		Layer.provide(DomainLive),
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

export const assertEventsAcceptedByConversationServices = async (
	events: ReadonlyArray<AgentEvent>,
): Promise<void> => {
	const dir = mkdtempSync(join(tmpdir(), "zuse-provider-fixture-"));
	const runtime = makeRuntime(join(dir, "fixture.sqlite"), events);
	const run = <A>(
		effect: Effect.Effect<A, unknown, TestConversation | SqlClient.SqlClient>,
	): Promise<A> =>
		runtime.runPromise(effect as Effect.Effect<A, unknown, never>);

	try {
		await run(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const now = new Date().toISOString();
				yield* sql`
          INSERT INTO projects (id, path, name, created_at, updated_at)
          VALUES (${FIXTURE_PROJECT_ID}, ${FIXTURE_PROJECT_PATH}, ${"Fixture"}, ${now}, ${now})
        `;
			}),
		);

		const { initialSession } = await run(
			Effect.flatMap(TestConversation, (store) =>
				store.createChat({
					projectId: FIXTURE_PROJECT_ID,
					providerId: "claude",
					model: "fixture-model",
					initialPrompt: "replay fixture",
				}),
			),
		);

		const expectedRenderableCount = new Set(
			events.flatMap((event, index) => {
				if (!renderableTags.has(event._tag)) return [];
				return [
					"itemId" in event && typeof event.itemId === "string"
						? `${event._tag}:${event.itemId}`
						: `${event._tag}:${index}`,
				];
			}),
		).size;

		const waitForReplay = Effect.gen(function* () {
			const store = yield* TestConversation;
			const messages = yield* store.listMessages(initialSession.id);
			const providerMessages = messages.filter(
				(message) => message.role !== "user",
			);
			const session = yield* store.getSession(initialSession.id);
			if (providerMessages.length < expectedRenderableCount) {
				return yield* Effect.fail(
					"provider messages not replayed yet" as const,
				);
			}
			const cursorEvent = events.find(
				(event) => event._tag === "SessionCursor",
			);
			if (
				cursorEvent !== undefined &&
				(session.cursor !== cursorEvent.cursor ||
					session.resumeStrategy !== cursorEvent.strategy)
			) {
				return yield* Effect.fail("session cursor not persisted yet" as const);
			}
			return { providerMessages, session };
		}).pipe(
			Effect.retry(
				Schedule.max([Schedule.spaced("10 millis"), Schedule.recurs(100)]),
			),
		);

		await run(waitForReplay);
	} finally {
		await runtime.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
};
