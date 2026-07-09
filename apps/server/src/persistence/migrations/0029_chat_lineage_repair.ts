import { SqlClient } from "@effect/sql";
import { Effect } from "effect";

/**
 * Repair databases that advanced past migration 23 before the chat lineage
 * column shipped. The migrator records numeric ids, so once a database has
 * applied 24+ it will not go back and run 23. Keep this idempotent for both
 * repaired and already-correct schemas.
 */
export const Migration0029ChatLineageRepair = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(chats)
  `;
  const hasOriginSessionId = columns.some(
    (column) => column.name === "origin_session_id",
  );
  if (!hasOriginSessionId) {
    yield* sql`
      ALTER TABLE chats
      ADD COLUMN origin_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL
    `;
  }
});
