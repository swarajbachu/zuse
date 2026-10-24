import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Hourly usage history that outlives source-tool log rotation, a local cache
 * of the opt-in account backup, and backup bookkeeping. Existing
 * `usage_cost_daily` rows stay as read-only history for older days.
 */
export const Migration0093UsageHistory = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE usage_history (
    hour TEXT NOT NULL, source_id TEXT NOT NULL, model TEXT NOT NULL,
    session_id TEXT NOT NULL, project_path TEXT NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL,
    cache_creation_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, cost_usd REAL,
    record_count INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
    change_seq INTEGER NOT NULL,
    PRIMARY KEY(hour, source_id, model, session_id, project_path)
  )`;
	yield* sql`CREATE INDEX usage_history_change_seq ON usage_history(change_seq)`;
	yield* sql`CREATE TABLE usage_history_remote (
    hour TEXT NOT NULL, source_id TEXT NOT NULL, model TEXT NOT NULL,
    session TEXT NOT NULL, project TEXT NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL,
    cache_creation_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, cost_usd REAL,
    record_count INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
    PRIMARY KEY(hour, source_id, model, session, project)
  )`;
	yield* sql`CREATE TABLE usage_backup_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
});
