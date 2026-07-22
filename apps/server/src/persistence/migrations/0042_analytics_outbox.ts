import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Durable, privacy-filtered analytics awaiting best-effort ingestion. */
export const Migration0042AnalyticsOutbox = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE IF NOT EXISTS analytics_outbox (
    id TEXT PRIMARY KEY,
    distinct_id TEXT NOT NULL,
    event TEXT NOT NULL,
    properties_json TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL
  )`;
	yield* sql`CREATE INDEX IF NOT EXISTS idx_analytics_outbox_due
    ON analytics_outbox(next_attempt_at, captured_at)`;
});
