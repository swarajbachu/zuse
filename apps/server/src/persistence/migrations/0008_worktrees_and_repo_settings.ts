import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * Worktrees + per-repository settings.
 *
 *  - `worktrees` rows track each `git worktree` memoize owns for a project.
 *    Removed from disk via `WorktreeService.remove`; cascades from the
 *    parent project so deleting a project drops the rows too (the disk
 *    removal step happens before the DB delete in the service so we never
 *    leak orphan checkouts).
 *  - `sessions.worktree_id` points at the worktree the session runs in.
 *    NULL means the session uses the project's main checkout. Set to NULL
 *    when the worktree row is removed so the session falls back to the
 *    main checkout instead of pointing at a missing row.
 *  - `repository_settings` carries per-repo overrides. Every override is
 *    nullable so the renderer can fall through to the global default.
 */
export const Migration0008WorktreesAndRepoSettings = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, path)
    )
  `;

  yield* sql`
    CREATE INDEX idx_worktrees_project
      ON worktrees(project_id, created_at DESC)
  `;

  yield* sql`
    ALTER TABLE sessions
      ADD COLUMN worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL
  `;

  yield* sql`
    CREATE TABLE repository_settings (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      default_provider_id TEXT,
      default_model TEXT,
      default_runtime_mode TEXT,
      auto_create_worktree INTEGER NOT NULL DEFAULT 0,
      worktree_base_dir TEXT
    )
  `;
});
