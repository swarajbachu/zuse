import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * Adds `runtime_mode` to `sessions`. Default is `approval-required` — the
 * safe default that matches existing behavior (every write / shell / network
 * tool prompts). Existing rows get the default automatically; the toggle in
 * the chat header lets the user move sessions to `auto-accept-edits` or
 * `full-access` once they trust the agent.
 */
export const Migration0005RuntimeMode = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE sessions
    ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'approval-required'
  `;
});
