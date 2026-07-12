import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * Adds resume metadata to the `sessions` table:
 *
 *   - `cursor`           — provider-specific resume token. For Claude it's
 *                          the SDK's `session_id` UUID; for Codex it's null
 *                          until the SDK exposes a programmatic resume hook.
 *   - `resume_strategy`  — `"claude-session-id" | "none"`. The renderer reads
 *                          this to decide whether the "Resumable" badge is
 *                          available on a stopped session.
 *
 * Both columns default-safe: existing rows backfill to `cursor IS NULL`,
 * `resume_strategy = 'none'`. Sessions started after this migration have
 * the cursor populated lazily once the first SDK message is observed.
 */
export const Migration0003ResumeAndExport = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE sessions ADD COLUMN cursor TEXT`;
  yield* sql`
    ALTER TABLE sessions
      ADD COLUMN resume_strategy TEXT NOT NULL DEFAULT 'none'
  `;
});
