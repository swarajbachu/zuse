import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Makes provider replay deduplication proportional to the number of events
 * sharing an item id instead of the entire session transcript.
 */
export const Migration0034ToolEventLookup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX idx_messages_tool_item
      ON messages(session_id, kind, json_extract(content_json, '$.itemId'))
      WHERE kind = 'tool_use' AND json_valid(content_json)
  `;
});
