import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

export const Migration0015QueuedMessages = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS queued_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      queue_order INTEGER NOT NULL,
      input_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(queued_messages)
  `;
  const hasColumn = (name: string): boolean =>
    columns.some((column) => column.name === name);

  // A previous failed app boot may have created the first draft of this table
  // with a `position` column before failing later in the migration. Keep that
  // database recoverable by adding the non-keyword column and copying values.
  if (!hasColumn("queue_order")) {
    yield* sql`
      ALTER TABLE queued_messages
        ADD COLUMN queue_order INTEGER NOT NULL DEFAULT 0
    `;
    if (hasColumn("position")) {
      yield* sql`
        UPDATE queued_messages SET queue_order = "position"
      `;
    }
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_queued_messages_session_position
    ON queued_messages(session_id, queue_order)
  `;
});
