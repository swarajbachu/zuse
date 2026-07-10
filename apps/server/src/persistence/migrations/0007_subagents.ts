import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * Sub-agents support.
 *
 *  - `messages.parent_item_id` references the `Agent` tool_use's `itemId`
 *    when the row originated inside a sub-agent. Nullable; NULL means
 *    "top-level (main agent)". Stored alongside `content_json` (which
 *    also carries `parentItemId`) so the renderer can index nesting
 *    without a JSON extract.
 *  - `sessions.agents_json` is the JSON-serialised `agents` map the user
 *    chose for this session at start-time. Persisted so a resumed
 *    session re-passes the same roster into `provider.start`, preserving
 *    the sub-agent set across reloads.
 */
export const Migration0007Subagents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE messages ADD COLUMN parent_item_id TEXT
  `;
  yield* sql`
    CREATE INDEX idx_messages_parent_item
      ON messages(session_id, parent_item_id)
  `;
  yield* sql`
    ALTER TABLE sessions ADD COLUMN agents_json TEXT
  `;
});
