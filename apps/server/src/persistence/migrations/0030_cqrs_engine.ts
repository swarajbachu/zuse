import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Expands the existing message event log into the durable CQRS engine schema.
 * Existing message events become their own root correlations. The legacy
 * projector watermark is retained as the initial messages-projector cursor;
 * lifecycle backfill advances the remaining cursors after it commits.
 */
export const Migration0030CqrsEngine = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;

	yield* sql`ALTER TABLE events ADD COLUMN correlation_id TEXT`;
	yield* sql`ALTER TABLE events ADD COLUMN causation_event_id TEXT`;
	yield* sql`
    UPDATE events SET correlation_id = event_id
    WHERE correlation_id IS NULL
  `;
	yield* sql`
    CREATE INDEX idx_events_correlation ON events(correlation_id, sequence)
  `;
	yield* sql`
    CREATE INDEX idx_events_causation ON events(causation_event_id)
  `;

	yield* sql`
    CREATE TABLE command_receipts (
      command_id      TEXT PRIMARY KEY,
      stream_kind    TEXT NOT NULL,
      stream_id      TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      event_ids_json TEXT NOT NULL,
      result_json    TEXT,
      created_at     TEXT NOT NULL
    )
  `;
	yield* sql`
    CREATE INDEX idx_command_receipts_stream
      ON command_receipts(stream_kind, stream_id, created_at)
  `;

	yield* sql`
    CREATE TABLE projector_cursors (
      projector_name TEXT PRIMARY KEY,
      last_sequence  INTEGER NOT NULL CHECK (last_sequence >= 0),
      updated_at     TEXT NOT NULL
    )
  `;
	yield* sql`
    INSERT INTO projector_cursors (projector_name, last_sequence, updated_at)
    VALUES (
      'messages',
      COALESCE(
        (SELECT CAST(value AS INTEGER) FROM app_state
         WHERE key = 'projector_watermark'),
        0
      ),
      CURRENT_TIMESTAMP
    )
  `;
});
