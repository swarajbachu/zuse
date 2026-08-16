import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

export const Migration0016QueuedMessagesQueueOrderRepair = Effect.gen(
  function* () {
    const sql = yield* SqlClient.SqlClient;

    const table = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'queued_messages'
    `;
    if (table.length === 0) return;

    const columns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(queued_messages)
    `;
    const hasColumn = (name: string): boolean =>
      columns.some((column) => column.name === name);

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
      CREATE INDEX IF NOT EXISTS idx_queued_messages_session_queue_order
      ON queued_messages(session_id, queue_order)
    `;
  },
);
