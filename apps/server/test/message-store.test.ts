import { beforeEach, describe, expect, it } from "bun:test";
import { SqlClient } from "@effect/sql";
// The server ships on the built-in `node:sqlite`, which Bun does not provide.
// `@effect/sql-sqlite-bun` produces the same generic `SqlClient` tag on top
// of the built-in `bun:sqlite`, so MessageStoreLive runs unchanged under
// `bun test`. Test-only — the app keeps the node client.
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Chunk, Effect, Layer, ManagedRuntime, Schedule, Stream } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentEvent,
  AgentSessionId,
  FolderId,
  SessionId,
  StartSessionInput,
  WorktreeId,
} from "@zuse/wire";
import {
  ComposerInput,
  MessageId,
  RepositorySettings,
  Worktree,
} from "@zuse/wire";

import { NdjsonLogger } from "../src/persistence/ndjson-logger.ts";
import { RelayActivityPublisher } from "../src/relay/activity-publisher.ts";
import { Migration0001Initial } from "../src/persistence/migrations/0001_initial.ts";
import { Migration0002Permissions } from "../src/persistence/migrations/0002_permissions.ts";
import { Migration0003ResumeAndExport } from "../src/persistence/migrations/0003_resume_and_export.ts";
import { Migration0004PermissionScope } from "../src/persistence/migrations/0004_permission_scope.ts";
import { Migration0005RuntimeMode } from "../src/persistence/migrations/0005_runtime_mode.ts";
import { Migration0006Attachments } from "../src/persistence/migrations/0006_attachments.ts";
import { Migration0007Subagents } from "../src/persistence/migrations/0007_subagents.ts";
import { Migration0008WorktreesAndRepoSettings } from "../src/persistence/migrations/0008_worktrees_and_repo_settings.ts";
import { Migration0009PermissionModeAndToolSearch } from "../src/persistence/migrations/0009_permission_mode_and_tool_search.ts";
import { Migration0010NestedSessions } from "../src/persistence/migrations/0010_nested_sessions.ts";
import { Migration0011ChatsTable } from "../src/persistence/migrations/0011_chats_table.ts";
import { Migration0012ChatIdNotNull } from "../src/persistence/migrations/0012_chat_id_not_null.ts";
import { Migration0013ArchiveCleanup } from "../src/persistence/migrations/0013_archive_cleanup.ts";
import { Migration0014ScriptsAndSetup } from "../src/persistence/migrations/0014_scripts_and_setup.ts";
import { Migration0015QueuedMessages } from "../src/persistence/migrations/0015_queued_messages.ts";
import { Migration0016QueuedMessagesQueueOrderRepair } from "../src/persistence/migrations/0016_queued_messages_queue_order_repair.ts";
import { Migration0017ChatReadState } from "../src/persistence/migrations/0017_chat_read_state.ts";
import { Migration0018PokemonWorktrees } from "../src/persistence/migrations/0018_pokemon_worktrees.ts";
import { Migration0019QueuePaused } from "../src/persistence/migrations/0019_queue_paused.ts";
import { Migration0020Events } from "../src/persistence/migrations/0020_events.ts";
import { WorktreeService } from "../src/worktree/services/worktree-service.ts";
import { MessageStore } from "../src/provider/services/message-store.ts";
import { ProviderService } from "../src/provider/services/provider-service.ts";
import { MessageStoreLive } from "../src/provider/layers/message-store.ts";
import { PtyService } from "../src/pty/services/pty-service.ts";
import { RepositorySettingsService } from "../src/repository-settings/services/repository-settings-service.ts";
import { GitService } from "../src/git/services/git-service.ts";
import { TitleGenerator } from "../src/provider/title-generator.ts";
import { ConfigStoreService } from "../src/config-store/services/config-store-service.ts";

const PROJECT_ID = "proj-test" as FolderId;
const TEST_WORKTREE_ID = "wt-pikachu" as WorktreeId;
const TEST_WORKTREE_PATH = "/tmp/project/.memo/pikachu";

/**
 * Scripted provider events the stub replays on `events()` for the next
 * created session. The MessageStore boot path subscribes to this stream and
 * persists each renderable event — letting us assert the full
 * provider-event → messages-table pipeline without a real agent CLI.
 */
let scriptedEvents: ReadonlyArray<AgentEvent> = [];
let providerStartInputs: StartSessionInput[] = [];
let providerStartCursors: Array<string | null> = [];

/** A no-op ProviderService: starts/sends succeed; events replay the script. */
const StubProviderLive = Layer.succeed(ProviderService, {
  availability: () => Effect.succeed([]),
  start: (input, resumeCursor) =>
    Effect.sync(() => {
      providerStartInputs.push(input);
      providerStartCursors.push(resumeCursor);
      return {
        sessionId: input.sessionId ?? ("stub" as AgentSessionId),
      };
    }),
  send: () => Effect.void,
  interrupt: () => Effect.void,
  close: () => Effect.void,
  events: () => Stream.fromIterable(scriptedEvents),
  setCredential: () => Effect.void,
  setPermissionMode: () => Effect.void,
  answerQuestion: () => Effect.void,
  getGoal: () => Effect.succeed(null),
  setGoal: () => Effect.die("not used"),
  clearGoal: () => Effect.void,
});

const testWorktree = Worktree.make({
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
  create: () => Effect.die("not used"),
  list: () => Effect.succeed([]),
  get: (worktreeId) =>
    Effect.succeed(worktreeId === TEST_WORKTREE_ID ? testWorktree : null),
  updateBranch: () => Effect.void,
  remove: () => Effect.void,
  rerunSetup: () => Effect.die("not used"),
  startRun: () => Effect.die("not used"),
  restore: () => Effect.die("not used"),
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
  changes: () => Effect.die("not used"),
  diff: () => Effect.die("not used"),
  commit: () => Effect.die("not used"),
  push: () => Effect.die("not used"),
  mergePr: () => Effect.die("not used"),
  markReady: () => Effect.die("not used"),
  init: () => Effect.die("not used"),
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

/** Chat archive cleanup is out of scope for MessageStore persistence tests. */
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
        archiveRemoveWorktree: false,
        setupScript: null,
        runScript: null,
        autoRunAfterSetup: false,
        environmentVariables: {},
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
        archiveRemoveWorktree: patch.archiveRemoveWorktree ?? false,
        setupScript: patch.setupScript ?? null,
        runScript: patch.runScript ?? null,
        autoRunAfterSetup: patch.autoRunAfterSetup ?? false,
        environmentVariables: patch.environmentVariables ?? {},
        fileIncludeGlobs: patch.fileIncludeGlobs ?? "",
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
  ],
  { discard: true },
);

const makeRuntime = (dbPath: string) => {
  const SqlLive = SqliteClient.layer({ filename: dbPath });
  // Run migrations during layer build, and re-export SqlClient downstream.
  const Migrated = Layer.effectDiscard(runAllMigrations).pipe(
    Layer.provideMerge(SqlLive),
  );
  const TestLayer = MessageStoreLive.pipe(
    Layer.provide(StubProviderLive),
    Layer.provide(StubWorktreeLive),
    Layer.provide(StubRepositorySettingsLive),
    Layer.provide(StubPtyLive),
    Layer.provide(StubNdjsonLive),
    Layer.provide(StubGitLive),
    Layer.provide(StubTitleGeneratorLive),
    Layer.provide(StubConfigStoreLive),
    Layer.provide(StubRelayActivityPublisherLive),
    // provideMerge (not provide) so SqlClient stays in the runtime context —
    // the test seeds the `projects` row through it directly.
    Layer.provideMerge(Migrated),
  );
  return ManagedRuntime.make(TestLayer);
};

const withRuntime = async <A>(
  fn: (
    run: <X>(
      eff: Effect.Effect<X, unknown, MessageStore | SqlClient.SqlClient>,
    ) => Promise<X>,
  ) => Promise<A>,
): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "mz-msgstore-"));
  const dbPath = join(dir, "test.sqlite");
  const runtime = makeRuntime(dbPath);
  const run = <X>(
    eff: Effect.Effect<X, unknown, MessageStore | SqlClient.SqlClient>,
  ): Promise<X> => runtime.runPromise(eff as Effect.Effect<X, unknown, never>);
  try {
    // Seed the project row through the runtime's own SqlClient.
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const now = new Date().toISOString();
        yield* sql`
          INSERT INTO projects (id, path, name, created_at, updated_at)
          VALUES (${PROJECT_ID}, ${"/tmp/project"}, ${"Test"}, ${now}, ${now})
        `;
      }),
    );
    return await fn(run);
  } finally {
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
};

const store = MessageStore;

beforeEach(() => {
  providerStartInputs = [];
  providerStartCursors = [];
});

describe("MessageStore migrations", () => {
  it("0016 repairs queued_messages rows from the old position column", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mz-queue-migration-"));
    const dbPath = join(dir, "test.sqlite");
    const runtime = ManagedRuntime.make(
      SqliteClient.layer({ filename: dbPath }),
    );
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
});

describe("MessageStore — chat & session lifecycle", () => {
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
      // hasInitial → session boots straight into "running".
      expect(result.initialSession.status).toBe("running");
      expect(result.initialMessage?.role).toBe("user");
      expect(result.initialMessage?.content).toMatchObject({
        _tag: "user",
        text: "fix the bug",
      });
      expect(providerStartInputs.at(-1)?.cwdOverride).toBeUndefined();
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
      expect(providerStartInputs.at(-1)?.cwdOverride).toBe(TEST_WORKTREE_PATH);
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
      expect(providerStartInputs).toHaveLength(1);
      expect(providerStartInputs[0]?.cwdOverride).toBe(TEST_WORKTREE_PATH);
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
        ).pipe(Effect.either),
      );
      expect(exit._tag).toBe("Left");
      if (exit._tag === "Left") {
        expect((exit.left as { _tag: string })._tag).toBe(
          "SessionNotFoundError",
        );
      }
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

      await run(
        Effect.flatMap(store, (s) => s.interruptSession(initialSession.id)),
      );
      await run(
        Effect.flatMap(store, (s) => s.flushQueuedMessages(initialSession.id)),
      );

      const queue = await run(
        Effect.flatMap(store, (s) => s.listQueuedMessages(initialSession.id)),
      );
      expect(queue.paused).toBe(true);
      expect(queue.items.map((item) => item.input.text)).toEqual(["resume me"]);
    });
  });

  it("resumeQueuedMessages clears pause and sends the head queued item", async () => {
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
        Effect.flatMap(store, (s) => s.interruptSession(initialSession.id)),
      );

      await run(
        Effect.flatMap(store, (s) => s.resumeQueuedMessages(initialSession.id)),
      );

      const queue = await run(
        Effect.flatMap(store, (s) => s.listQueuedMessages(initialSession.id)),
      );
      expect(queue.paused).toBe(false);
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

describe("MessageStore — provider event persistence", () => {
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
            Schedule.spaced("10 millis").pipe(
              Schedule.intersect(Schedule.recurs(100)),
            ),
          ),
          Effect.either,
        );

        const assistant = await run(findAssistant);
        expect(assistant._tag).toBe("Right");
        if (assistant._tag === "Right") {
          expect(assistant.right.content).toMatchObject({
            _tag: "assistant",
            text: "all done",
          });
        }
      });
    } finally {
      scriptedEvents = [];
    }
  });
});

describe("MessageStore cursor streaming", () => {
  const userText = (envelope: { readonly message: { content: unknown } }) =>
    (envelope.message.content as { text?: string }).text;

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
        await run(Effect.flatMap(store, (s) => s.sendMessage(id, text)));
      }

      // First subscription: full replay of the three persisted rows.
      const first = await run(
        Effect.flatMap(store, (s) =>
          Stream.runCollect(s.streamMessages(id).pipe(Stream.take(3))),
        ),
      ).then(Chunk.toReadonlyArray);
      expect(first.map(userText)).toEqual(["m1", "m2", "m3"]);
      const sequences = first.map((e) => e.sequence);
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
      const cursor = sequences.at(-1)!;

      // "Network drop": the first stream is gone; more rows land meanwhile.
      for (const text of ["m4", "m5"]) {
        await run(Effect.flatMap(store, (s) => s.sendMessage(id, text)));
      }

      // Resubscribe with the recorded cursor — exactly the delta, in order.
      const resumed = await run(
        Effect.flatMap(store, (s) =>
          Stream.runCollect(s.streamMessages(id, cursor).pipe(Stream.take(2))),
        ),
      ).then(Chunk.toReadonlyArray);
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
      await run(Effect.flatMap(store, (s) => s.sendMessage(id, "m1")));

      // Subscribe past m1, then persist m2/m3 while the stream is live —
      // they must arrive via the tail, once each, in sequence order.
      const collected = await run(
        Effect.gen(function* () {
          const s = yield* store;
          const fiber = yield* Effect.fork(
            Stream.runCollect(s.streamMessages(id).pipe(Stream.take(3))),
          );
          yield* s.sendMessage(id, "m2");
          yield* s.sendMessage(id, "m3");
          return Chunk.toReadonlyArray(
            yield* fiber.await.pipe(Effect.flatMap((exit) => exit)),
          );
        }),
      );
      expect(collected.map(userText)).toEqual(["m1", "m2", "m3"]);
      expect(new Set(collected.map((e) => e.message.id)).size).toBe(3);
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

      await run(Effect.flatMap(store, (s) => s.sendMessage(a, "a1")));
      await run(Effect.flatMap(store, (s) => s.sendMessage(b, "b1")));
      await run(Effect.flatMap(store, (s) => s.sendMessage(a, "a2")));

      const forA = await run(
        Effect.flatMap(store, (s) =>
          Stream.runCollect(s.streamMessages(a).pipe(Stream.take(2))),
        ),
      ).then(Chunk.toReadonlyArray);
      const forB = await run(
        Effect.flatMap(store, (s) =>
          Stream.runCollect(s.streamMessages(b).pipe(Stream.take(1))),
        ),
      ).then(Chunk.toReadonlyArray);

      expect(forA.map(userText)).toEqual(["a1", "a2"]);
      expect(forB.map(userText)).toEqual(["b1"]);
      // Global cursor: b1 landed between a1 and a2.
      expect(forA[0]!.sequence).toBeLessThan(forB[0]!.sequence);
      expect(forB[0]!.sequence).toBeLessThan(forA[1]!.sequence);
    });
  });
});

describe("MessageStore — fork & transcript export", () => {
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
