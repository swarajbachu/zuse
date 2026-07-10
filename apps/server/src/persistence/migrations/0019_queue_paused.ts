import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * Tracks when a queued conversation should wait for an explicit Resume after
 * the user manually stopped a running turn.
 */
export const Migration0019QueuePaused = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(sessions)
  `;
  const hasColumn = (name: string): boolean =>
    sessionColumns.some((column) => column.name === name);

  if (!hasColumn("queue_paused")) {
    yield* sql`
      ALTER TABLE sessions
        ADD COLUMN queue_paused INTEGER NOT NULL DEFAULT 0
    `;
  }
});
