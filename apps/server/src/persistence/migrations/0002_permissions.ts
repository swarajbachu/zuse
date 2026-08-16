import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * Per-session permission decisions. Rows are append-only — one row per
 * resolved request. The kind payload is stored as JSON so adding a new
 * `PermissionKind` variant is a wire-only change. Decisions persist for
 * audit; the in-process driver short-circuit for "Allow for session"
 * reads from this table on lookup so re-prompts don't survive a crash.
 */
export const Migration0002Permissions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE permission_decisions (
      request_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      kind_tag TEXT NOT NULL,
      kind_key TEXT NOT NULL,
      kind_json TEXT NOT NULL,
      decision TEXT NOT NULL,
      decided_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_permission_decisions_session
      ON permission_decisions(session_id, kind_tag, kind_key)
  `;
});
