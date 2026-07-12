import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * Adds project scoping to `permission_decisions`. Existing rows get
 * `scope='session'` and `project_id=NULL` so the legacy short-circuit
 * (`session_id` + `kind_key` + `decision='AllowForSession'`) keeps working
 * untouched. New `AlwaysAllow` rows carry `scope='folder'` and a populated
 * `project_id` so a per-project lookup can match across sessions.
 */
export const Migration0004PermissionScope = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE permission_decisions ADD COLUMN project_id TEXT`;
  yield* sql`
    ALTER TABLE permission_decisions
    ADD COLUMN scope TEXT NOT NULL DEFAULT 'session'
  `;
  yield* sql`
    CREATE INDEX idx_permission_decisions_project
      ON permission_decisions(project_id, kind_tag, kind_key)
  `;
});
