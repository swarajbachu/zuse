import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * Adds `chats.origin_session_id` — lineage for agent-spawned threads. When a
 * session uses orchestration control-plane tools to spawn a new chat,
 * this records the spawning session so the sidebar can nest agent-spawned
 * chats under their parent and badge them.
 *
 * Nullable + `ON DELETE SET NULL`: user-created chats have no origin, and a
 * spawned chat outlives the session that created it (deleting the parent
 * session just clears the link, it doesn't cascade-delete the child chat).
 */
export const Migration0023ChatLineage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE chats
    ADD COLUMN origin_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL
  `;
});
