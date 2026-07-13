import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const Migration0036UsageCostDaily = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE usage_cost_daily (
    day TEXT NOT NULL, source_id TEXT NOT NULL, model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL,
    cache_creation_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, cost_usd REAL,
    cost_status TEXT NOT NULL, record_count INTEGER NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(day, source_id, model)
  )`;
});
