import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * Adds `parent_session_id` to `sessions` so a chat can host nested child
 * sessions ("tabs") that aren't visible in the sidebar. Children inherit the
 * parent's worktree (enforced server-side at insert). `ON DELETE CASCADE`
 * because a parent's deletion has to take its children with it — children
 * have no sidebar row to navigate back to once orphaned.
 *
 * The composite index on `(parent_session_id)` speeds up "list children of
 * session X" which the tab strip runs on every render.
 */
export const Migration0010NestedSessions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE sessions
    ADD COLUMN parent_session_id TEXT
    REFERENCES sessions(id) ON DELETE CASCADE
  `;
  yield* sql`
    CREATE INDEX idx_sessions_parent ON sessions(parent_session_id)
  `;
});
