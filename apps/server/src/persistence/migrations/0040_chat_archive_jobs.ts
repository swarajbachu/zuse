import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Durable resource-cleanup work that follows the logical chat archive. */
export const Migration0040ChatArchiveJobs = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`
    CREATE TABLE IF NOT EXISTS chat_archive_jobs (
      chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      command_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'completed', 'failed', 'forced', 'cancelled')
      ),
      phase TEXT NOT NULL,
      worktree_id TEXT,
      snapshot_json TEXT,
      acceptance_sessions_json TEXT NOT NULL DEFAULT '[]',
      cleanup_output TEXT NOT NULL DEFAULT '',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
	yield* sql`
		ALTER TABLE worktrees ADD COLUMN archive_state TEXT NOT NULL DEFAULT 'active'
		CHECK (archive_state IN ('active', 'deleting'))
	`;
	yield* sql`
		CREATE TRIGGER IF NOT EXISTS prevent_chat_deleting_worktree_insert
		BEFORE INSERT ON chats
		WHEN NEW.worktree_id IS NOT NULL AND EXISTS (
			SELECT 1 FROM worktrees WHERE id = NEW.worktree_id AND archive_state = 'deleting'
		)
		BEGIN SELECT RAISE(ABORT, 'worktree is being archived'); END
	`;
	yield* sql`
		CREATE TRIGGER IF NOT EXISTS prevent_chat_deleting_worktree_update
		BEFORE UPDATE OF worktree_id ON chats
		WHEN NEW.worktree_id IS NOT NULL AND EXISTS (
			SELECT 1 FROM worktrees WHERE id = NEW.worktree_id AND archive_state = 'deleting'
		)
		BEGIN SELECT RAISE(ABORT, 'worktree is being archived'); END
	`;
	yield* sql`
		CREATE TRIGGER IF NOT EXISTS prevent_session_deleting_worktree_insert
		BEFORE INSERT ON sessions
		WHEN NEW.worktree_id IS NOT NULL AND EXISTS (
			SELECT 1 FROM worktrees WHERE id = NEW.worktree_id AND archive_state = 'deleting'
		)
		BEGIN SELECT RAISE(ABORT, 'worktree is being archived'); END
	`;
	yield* sql`
		CREATE TRIGGER IF NOT EXISTS prevent_session_deleting_worktree_update
		BEFORE UPDATE OF worktree_id ON sessions
		WHEN NEW.worktree_id IS NOT NULL AND EXISTS (
			SELECT 1 FROM worktrees WHERE id = NEW.worktree_id AND archive_state = 'deleting'
		)
		BEGIN SELECT RAISE(ABORT, 'worktree is being archived'); END
	`;
	yield* sql`
    CREATE INDEX IF NOT EXISTS idx_chat_archive_jobs_status
    ON chat_archive_jobs(status, updated_at)
  `;
});
