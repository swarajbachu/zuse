import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { layer as nodeSqliteLayer } from "@zuse/sqlite";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import { Migration0030CqrsEngine } from "../src/persistence/migrations/0030_cqrs_engine.ts";
import { Migration0031BackfillRuns } from "../src/persistence/migrations/0031_backfill_runs.ts";
import { Migration0032ReactorEffectReceipts } from "../src/persistence/migrations/0032_reactor_effect_receipts.ts";
import { Migration0033ReactorEffectSteps } from "../src/persistence/migrations/0033_reactor_effect_steps.ts";
import { Migration0034ToolEventLookup } from "../src/persistence/migrations/0034_tool_event_lookup.ts";

describe("CQRS migrations", () => {
  test("adds durable CQRS state and indexed tool-event lookup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zuse-cqrs-migration-"));
    const filename = join(directory, "test.sqlite");
    const seed = new DatabaseSync(filename);
    seed.exec(`
			CREATE TABLE events (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				event_id TEXT NOT NULL UNIQUE,
				stream_kind TEXT NOT NULL,
				stream_id TEXT NOT NULL,
				stream_version INTEGER NOT NULL,
				type TEXT NOT NULL,
				occurred_at TEXT NOT NULL,
				actor TEXT,
				payload_json TEXT NOT NULL
			);
			CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				content_json TEXT NOT NULL
			);
			INSERT INTO events
				(event_id, stream_kind, stream_id, stream_version, type, occurred_at, payload_json)
			VALUES ('event-1', 'session', 'session-1', 1, 'MessagePersisted', '2026-01-01', '{}');
			INSERT INTO app_state (key, value) VALUES ('projector_watermark', '1');
			INSERT INTO messages (id, session_id, kind, content_json)
			VALUES ('malformed-tool', 'session-1', 'tool_use', '{not-json');
		`);
    seed.close();

    const runtime = ManagedRuntime.make(
      nodeSqliteLayer({ filename, disableWAL: true }),
    );
    try {
      const snapshot = await runtime.runPromise(
        Effect.gen(function* () {
          yield* Migration0030CqrsEngine;
          yield* Migration0031BackfillRuns;
          yield* Migration0032ReactorEffectReceipts;
          yield* Migration0033ReactorEffectSteps;
          yield* Migration0034ToolEventLookup;
          const sql = yield* SqlClient.SqlClient;
          const event = yield* sql<{
            readonly correlation_id: string;
            readonly causation_event_id: string | null;
          }>`SELECT correlation_id, causation_event_id FROM events`;
          const cursor = yield* sql<{
            readonly projector_name: string;
            readonly last_sequence: number;
          }>`SELECT projector_name, last_sequence FROM projector_cursors`;
          const tables = yield* sql<{ readonly name: string }>`
						SELECT name FROM sqlite_master
						WHERE type = 'table'
							AND name IN ('command_receipts', 'backfill_runs', 'reactor_effect_receipts', 'reactor_effect_steps')
						ORDER BY name
					`;
          const indexes = yield* sql<{ readonly name: string }>`
						SELECT name FROM sqlite_master
						WHERE type = 'index' AND name = 'idx_messages_tool_item'
					`;
          const malformedLookup = yield* sql<{ readonly id: string }>`
            SELECT id FROM messages
            WHERE session_id = 'session-1'
              AND kind = 'tool_use'
              AND json_valid(content_json)
              AND json_extract(content_json, '$.itemId') = 'missing'
          `;
          return { event, cursor, tables, indexes, malformedLookup };
        }),
      );

      expect(snapshot.event).toEqual([
        { correlation_id: "event-1", causation_event_id: null },
      ]);
      expect(snapshot.cursor).toEqual([
        { projector_name: "messages", last_sequence: 1 },
      ]);
      expect(snapshot.tables.map((table) => table.name)).toEqual([
        "backfill_runs",
        "command_receipts",
        "reactor_effect_receipts",
        "reactor_effect_steps",
      ]);
      expect(snapshot.indexes).toEqual([{ name: "idx_messages_tool_item" }]);
      expect(snapshot.malformedLookup).toEqual([]);
    } finally {
      await runtime.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
