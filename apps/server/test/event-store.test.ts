import { describe, expect, it } from "vitest";
import { layer as sqliteLayer } from "../src/persistence/node-sqlite-client.ts";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { Effect, Layer, ManagedRuntime } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROJECTOR_WATERMARK_KEY,
  isStreamVersionConflict,
  makeEventStore,
  type MessagePersistedPayload,
} from "../src/persistence/event-store.ts";
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

const MIGRATIONS_THROUGH_0019 = [
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
] as const;

/**
 * Run effects against a fresh temp-file DB using the production node:sqlite
 * layer and its generic SqlClient surface.
 * `throughMigration` lets the backfill test stop at 0019, seed legacy rows,
 * and then apply 0020 itself.
 */
const withSql = async <A>(
  fn: (
    run: <X>(
      eff: Effect.Effect<X, unknown, SqlClient.SqlClient>,
    ) => Promise<X>,
  ) => Promise<A>,
  options?: { readonly skip0020?: boolean },
): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "mz-eventstore-"));
  const migrations = options?.skip0020
    ? MIGRATIONS_THROUGH_0019
    : [...MIGRATIONS_THROUGH_0019, Migration0020Events];
  const Migrated = Layer.effectDiscard(
    Effect.all(migrations, { discard: true }),
  ).pipe(
    Layer.provideMerge(
      sqliteLayer({ filename: join(dir, "test.sqlite") }),
    ),
  );
  const runtime = ManagedRuntime.make(Migrated);
  const run = <X>(
    eff: Effect.Effect<X, unknown, SqlClient.SqlClient>,
  ): Promise<X> => runtime.runPromise(eff as Effect.Effect<X, unknown, never>);
  try {
    return await fn(run);
  } finally {
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
};

const NOW = "2026-07-02T12:00:00.000Z";

const seedChatFixture = (ids: {
  readonly projectId: string;
  readonly chatId: string;
  readonly sessionId: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT OR IGNORE INTO projects (id, path, name, created_at, updated_at)
      VALUES (${ids.projectId}, ${"/tmp/project"}, ${"Test"}, ${NOW}, ${NOW})
    `;
    yield* sql`
      INSERT INTO chats (id, project_id, title, created_at, updated_at)
      VALUES (${ids.chatId}, ${ids.projectId}, ${"Chat"}, ${NOW}, ${NOW})
    `;
    yield* sql`
      INSERT INTO sessions
        (id, project_id, title, provider_id, model, status, chat_id,
         created_at, updated_at)
      VALUES
        (${ids.sessionId}, ${ids.projectId}, ${"Session"}, ${"claude"},
         ${"test-model"}, ${"idle"}, ${ids.chatId}, ${NOW}, ${NOW})
    `;
  });

const payloadFor = (
  sessionId: string,
  messageId: string,
  createdAt = NOW,
): MessagePersistedPayload => ({
  messageId,
  sessionId,
  role: "user",
  kind: "user",
  contentJson: JSON.stringify({ _tag: "user", text: messageId, goal: false }),
  parentItemId: null,
  createdAt,
});

const appendFor = (sessionId: string, messageId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* makeEventStore(sql).appendEvent({
      streamKind: "session",
      streamId: sessionId,
      type: "MessagePersisted",
      actor: null,
      payload: payloadFor(sessionId, messageId),
    });
  });

describe("event store", () => {
  it("assigns contiguous per-stream versions and a strictly increasing global sequence", async () => {
    await withSql(async (run) => {
      await run(
        seedChatFixture({ projectId: "p1", chatId: "c1", sessionId: "s1" }),
      );
      await run(
        seedChatFixture({ projectId: "p1", chatId: "c2", sessionId: "s2" }),
      );

      // Interleave two streams: a few sequential appends, then a concurrent
      // batch — the one-permit connection serializes them, the unique index
      // guards the ordering invariant either way.
      await run(appendFor("s1", "m1"));
      await run(appendFor("s2", "m2"));
      await run(appendFor("s1", "m3"));
      await run(
        Effect.all(
          [
            appendFor("s1", "m4"),
            appendFor("s2", "m5"),
            appendFor("s1", "m6"),
            appendFor("s2", "m7"),
          ],
          { concurrency: 4 },
        ),
      );

      const events = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{
            readonly sequence: number;
            readonly stream_id: string;
            readonly stream_version: number;
          }>`
            SELECT sequence, stream_id, stream_version
            FROM events ORDER BY sequence ASC
          `;
        }),
      );

      expect(events).toHaveLength(7);
      const sequences = events.map((e) => e.sequence);
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
      expect(new Set(sequences).size).toBe(7);
      for (const stream of ["s1", "s2"]) {
        const versions = events
          .filter((e) => e.stream_id === stream)
          .map((e) => e.stream_version);
        expect(versions).toEqual(
          Array.from({ length: versions.length }, (_, i) => i + 1),
        );
      }

      const projected = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ readonly id: string; readonly sequence: number }>`
            SELECT id, sequence FROM messages ORDER BY sequence ASC
          `;
        }),
      );
      expect(projected.map((m) => m.id)).toEqual([
        "m1",
        "m2",
        "m3",
        "m4",
        "m5",
        "m6",
        "m7",
      ]);
    });
  });

  it("retries only the stream_version conflict, never an event_id collision", async () => {
    await withSql(async (run) => {
      await run(
        seedChatFixture({ projectId: "p1", chatId: "c1", sessionId: "s1" }),
      );
      await run(appendFor("s1", "m1"));

      // Force a real composite-unique violation through the same driver the
      // tests run on, and assert the retry predicate classifies it.
      const versionConflict = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql`
            INSERT INTO events
              (event_id, stream_kind, stream_id, stream_version, type,
               occurred_at, actor, payload_json)
            VALUES
              (${"dup-version"}, ${"session"}, ${"s1"}, ${1},
               ${"MessagePersisted"}, ${NOW}, ${null}, ${"{}"})
          `.pipe(Effect.flip);
        }),
      );
      expect(isStreamVersionConflict(versionConflict)).toBe(true);

      const eventIdRow = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ readonly event_id: string }>`
            SELECT event_id FROM events LIMIT 1
          `;
        }),
      );
      const eventIdConflict = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql`
            INSERT INTO events
              (event_id, stream_kind, stream_id, stream_version, type,
               occurred_at, actor, payload_json)
            VALUES
              (${eventIdRow[0]!.event_id}, ${"session"}, ${"s1"}, ${99},
               ${"MessagePersisted"}, ${NOW}, ${null}, ${"{}"})
          `.pipe(Effect.flip);
        }),
      );
      expect(isStreamVersionConflict(eventIdConflict)).toBe(false);
      expect(isStreamVersionConflict(new Error("nope"))).toBe(false);

      // appendEvent itself recovers: with the poisoned version-1 row gone,
      // a fresh append lands as version 2 without manual bookkeeping.
      const sequence = await run(appendFor("s1", "m2"));
      expect(sequence).toBeGreaterThan(1);
    });
  });

  it("replays from sequence 0 to reproduce the messages projection exactly", async () => {
    await withSql(async (run) => {
      await run(
        seedChatFixture({ projectId: "p1", chatId: "c1", sessionId: "s1" }),
      );
      for (const id of ["m1", "m2", "m3", "m4"]) {
        await run(appendFor("s1", id));
      }

      const snapshot = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql`
            SELECT id, session_id, role, kind, content_json, parent_item_id,
                   created_at, sequence
            FROM messages ORDER BY sequence ASC
          `;
        }),
      );
      expect(snapshot).toHaveLength(4);

      const rebuilt = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM messages`;
          yield* sql`
            UPDATE app_state SET value = '0'
            WHERE key = ${PROJECTOR_WATERMARK_KEY}
          `;
          yield* makeEventStore(sql).catchup;
          return yield* sql`
            SELECT id, session_id, role, kind, content_json, parent_item_id,
                   created_at, sequence
            FROM messages ORDER BY sequence ASC
          `;
        }),
      );
      expect(rebuilt).toEqual(snapshot);

      const watermark = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ readonly value: string }>`
            SELECT value FROM app_state WHERE key = ${PROJECTOR_WATERMARK_KEY}
          `;
        }),
      );
      const maxSequence = (snapshot as ReadonlyArray<{ sequence: number }>).at(
        -1,
      )!.sequence;
      expect(Number(watermark[0]!.value)).toBe(maxSequence);
    });
  });

  it("0020 backfills existing messages in (created_at, rowid) order and stamps sequences", async () => {
    await withSql(
      async (run) => {
        await run(
          seedChatFixture({ projectId: "p1", chatId: "c1", sessionId: "s1" }),
        );
        // Insert rows OUT of chronological order — backfill must order by
        // (created_at, rowid), not insertion order.
        const rows: ReadonlyArray<readonly [id: string, createdAt: string]> = [
          ["late", "2026-07-02T12:03:00.000Z"],
          ["early", "2026-07-02T12:01:00.000Z"],
          ["middle", "2026-07-02T12:02:00.000Z"],
          // same timestamp as "early" → rowid (insertion order) breaks the tie
          ["early-tie", "2026-07-02T12:01:00.000Z"],
        ];
        await run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            for (const [id, createdAt] of rows) {
              yield* sql`
                INSERT INTO messages
                  (id, session_id, role, kind, content_json, created_at)
                VALUES
                  (${id}, ${"s1"}, ${"user"}, ${"user"},
                   ${JSON.stringify({ _tag: "user", text: id, goal: false })},
                   ${createdAt})
              `;
            }
            yield* Migration0020Events;
          }),
        );

        const events = await run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{
              readonly event_id: string;
              readonly stream_version: number;
              readonly sequence: number;
            }>`
              SELECT event_id, stream_version, sequence
              FROM events ORDER BY sequence ASC
            `;
          }),
        );
        expect(events.map((e) => e.event_id)).toEqual([
          "backfill:early",
          "backfill:early-tie",
          "backfill:middle",
          "backfill:late",
        ]);
        expect(events.map((e) => e.stream_version)).toEqual([1, 2, 3, 4]);

        const stamped = await run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{
              readonly id: string;
              readonly sequence: number | null;
            }>`
              SELECT id, sequence FROM messages ORDER BY sequence ASC
            `;
          }),
        );
        expect(stamped.every((m) => m.sequence !== null)).toBe(true);
        expect(stamped.map((m) => m.id)).toEqual([
          "early",
          "early-tie",
          "middle",
          "late",
        ]);

        const watermark = await run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{ readonly value: string }>`
              SELECT value FROM app_state
              WHERE key = ${PROJECTOR_WATERMARK_KEY}
            `;
          }),
        );
        expect(Number(watermark[0]!.value)).toBe(events.at(-1)!.sequence);
      },
      { skip0020: true },
    );
  });

  it("catchup never resurrects messages of a deleted chat", async () => {
    await withSql(async (run) => {
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // Enable foreign keys so DELETE FROM chats cascades like production.
          yield* sql`PRAGMA foreign_keys = ON`.pipe(Effect.orDie);
        }),
      );
      await run(
        seedChatFixture({ projectId: "p1", chatId: "c1", sessionId: "s1" }),
      );
      await run(
        seedChatFixture({ projectId: "p1", chatId: "c2", sessionId: "s2" }),
      );
      await run(appendFor("s1", "kept"));
      await run(appendFor("s2", "doomed-1"));
      await run(appendFor("s2", "doomed-2"));

      const survivors = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM chats WHERE id = 'c2'`;
          // The events outlive the projection rows by design; a boot-time
          // catchup must not project them back into a dead session.
          yield* makeEventStore(sql).catchup;
          return yield* sql<{ readonly id: string }>`
            SELECT id FROM messages ORDER BY sequence ASC
          `;
        }),
      );
      expect(survivors.map((m) => m.id)).toEqual(["kept"]);

      const eventCount = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ readonly c: number }>`
            SELECT COUNT(*) AS c FROM events
          `;
        }),
      );
      expect(eventCount[0]!.c).toBe(3);
    });
  });
});
