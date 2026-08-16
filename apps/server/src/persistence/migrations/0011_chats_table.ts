import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * Replaces the v3 `parent_session_id` self-reference with a dedicated
 * `chats` container table. Each chat groups sessions that share a workspace
 * (project + worktree); each session belongs to exactly one chat via
 * `chat_id`. The previous "parent doubles as first tab" asymmetry — and the
 * promote-on-close, lastActiveTabByParent, and active-parent walk-ups it
 * forced — is gone.
 *
 * Backfill strategy:
 *   - Every existing top-level session (parent_session_id IS NULL) becomes
 *     its own chat. The chat's title / worktree / timestamps mirror the
 *     session, and active_session_id points to it.
 *   - Every existing v3 child inherits its parent's new chat_id.
 *
 * `chat_id` ships nullable here because SQLite can't add a NOT-NULL FK to a
 * populated table in one ALTER. The follow-up migration (after we verify
 * Option A in production) drops `parent_session_id`, drops the v3 index,
 * and enforces `chat_id NOT NULL` via a table rebuild.
 *
 * `forked_from_*` columns ship now (cheap), UI later — the future
 * fork-from-message feature drops in without another migration.
 */
export const Migration0011ChatsTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE chats (
      id                 TEXT PRIMARY KEY,
      project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      worktree_id        TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
      title              TEXT NOT NULL,
      active_session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      archived_at        TEXT,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    )
  `;

  yield* sql`CREATE INDEX idx_chats_project ON chats(project_id)`;

  yield* sql`
    INSERT INTO chats (
      id, project_id, worktree_id, title, active_session_id,
      archived_at, created_at, updated_at
    )
    SELECT
      lower(hex(randomblob(16))),
      project_id,
      worktree_id,
      title,
      id,
      archived_at,
      created_at,
      updated_at
    FROM sessions
    WHERE parent_session_id IS NULL
  `;

  yield* sql`
    ALTER TABLE sessions
    ADD COLUMN chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE
  `;

  yield* sql`
    UPDATE sessions
    SET chat_id = (
      SELECT id FROM chats WHERE chats.active_session_id = sessions.id
    )
    WHERE parent_session_id IS NULL
  `;

  yield* sql`
    UPDATE sessions
    SET chat_id = (
      SELECT chat_id FROM sessions AS s2 WHERE s2.id = sessions.parent_session_id
    )
    WHERE parent_session_id IS NOT NULL
  `;

  yield* sql`CREATE INDEX idx_sessions_chat ON sessions(chat_id)`;

  yield* sql`
    ALTER TABLE sessions
    ADD COLUMN forked_from_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL
  `;

  yield* sql`
    ALTER TABLE sessions
    ADD COLUMN forked_from_message_id TEXT
  `;
});
