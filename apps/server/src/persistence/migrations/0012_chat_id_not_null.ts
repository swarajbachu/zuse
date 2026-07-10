import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * Completes the chat-container backfill 0011 deferred. Two responsibilities:
 *
 * 1. Heal `sessions.chat_id` for any row left NULL by 0011. 0011's parent
 *    walk-up was a single UPDATE, so a chain `A (top) → B → C` only filled
 *    `B.chat_id` — the subquery saw `C`'s parent (`B`) still NULL at
 *    statement-evaluation time and produced NULL for `C`. The recursive CTE
 *    below resolves arbitrarily deep nesting in one statement. Any
 *    pathological orphan (parent chain never reaches a top-level row) gets a
 *    fresh chat mirroring its session — same shape 0011 used for the initial
 *    seed.
 *
 * 2. Flip `chat_id` to NOT NULL via a table rebuild (SQLite can't ALTER a
 *    column constraint in place). Indexes are recreated; FKs from
 *    `messages.session_id`, `chats.active_session_id`, and
 *    `sessions.parent_session_id` continue to resolve because the rebuilt
 *    table is renamed back to `sessions`.
 *
 * Dropping `parent_session_id` (also flagged in 0011) is intentionally
 * deferred — the column is harmless and a separate migration keeps blast
 * radius small.
 */
export const Migration0012ChatIdNotNull = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Heal: propagate each session's top-level ancestor's chat_id down its
  // parent chain. Sessions whose ancestor chain reaches a top-level row are
  // covered here.
  yield* sql`
    WITH RECURSIVE ancestor(id, chat_id) AS (
      SELECT id, chat_id FROM sessions WHERE parent_session_id IS NULL
      UNION ALL
      SELECT s.id, a.chat_id
      FROM sessions s
      JOIN ancestor a ON s.parent_session_id = a.id
    )
    UPDATE sessions
    SET chat_id = (
      SELECT chat_id FROM ancestor WHERE ancestor.id = sessions.id
    )
    WHERE chat_id IS NULL
      AND id IN (SELECT id FROM ancestor)
  `;

  // Orphan heal: anything still NULL is a session whose parent chain never
  // resolves to a top-level row. Mint a chat per orphan (mirroring 0011's
  // seed shape) and point the session at it.
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
    WHERE chat_id IS NULL
  `;

  yield* sql`
    UPDATE sessions
    SET chat_id = (
      SELECT id FROM chats WHERE chats.active_session_id = sessions.id
    )
    WHERE chat_id IS NULL
  `;

  // Rebuild `sessions` to enforce `chat_id NOT NULL`. SQLite's table-rebuild
  // idiom: create the replacement, copy rows, drop the original, rename.
  yield* sql`
    CREATE TABLE sessions_new (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      cursor TEXT,
      resume_strategy TEXT NOT NULL DEFAULT 'none',
      runtime_mode TEXT NOT NULL DEFAULT 'approval-required',
      agents_json TEXT,
      worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
      permission_mode TEXT NOT NULL DEFAULT 'default',
      tool_search INTEGER NOT NULL DEFAULT 0,
      parent_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      forked_from_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      forked_from_message_id TEXT
    )
  `;

  yield* sql`
    INSERT INTO sessions_new (
      id, project_id, title, provider_id, model, status,
      archived_at, created_at, updated_at,
      cursor, resume_strategy, runtime_mode, agents_json, worktree_id,
      permission_mode, tool_search, parent_session_id,
      chat_id, forked_from_session_id, forked_from_message_id
    )
    SELECT
      id, project_id, title, provider_id, model, status,
      archived_at, created_at, updated_at,
      cursor, resume_strategy, runtime_mode, agents_json, worktree_id,
      permission_mode, tool_search, parent_session_id,
      chat_id, forked_from_session_id, forked_from_message_id
    FROM sessions
  `;

  yield* sql`DROP TABLE sessions`;
  yield* sql`ALTER TABLE sessions_new RENAME TO sessions`;

  yield* sql`
    CREATE INDEX idx_sessions_project
      ON sessions(project_id, archived_at, updated_at DESC)
  `;
  yield* sql`CREATE INDEX idx_sessions_parent ON sessions(parent_session_id)`;
  yield* sql`CREATE INDEX idx_sessions_chat ON sessions(chat_id)`;
});
