import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const Migration0035UsageLimitSnapshots = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE usage_limit_snapshots (
    provider_id TEXT NOT NULL, account_key TEXT NOT NULL DEFAULT '', window_id TEXT NOT NULL,
    captured_hour TEXT NOT NULL, used_percent REAL, resets_at TEXT, window_minutes INTEGER,
    source TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(provider_id, account_key, window_id, captured_hour)
  )`;
});
