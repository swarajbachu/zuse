import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Durable once-only marker for the non-destructive lifecycle event backfill. */
export const Migration0031BackfillRuns = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;

	yield* sql`
    CREATE TABLE backfill_runs (
      backfill_name TEXT PRIMARY KEY,
      status        TEXT NOT NULL CHECK (status IN ('running', 'completed')),
      started_at    TEXT NOT NULL,
      completed_at  TEXT,
      event_count   INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0)
    )
  `;
});
