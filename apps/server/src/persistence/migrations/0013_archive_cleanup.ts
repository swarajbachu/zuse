import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * Archive cleanup settings + worktree restore metadata.
 *
 * `repository_settings.archive_cleanup_script` is the user-authored shell
 * body Memoize runs when archiving a worktree-backed chat. NULL/empty means
 * no cleanup.
 *
 * `repository_settings.archive_remove_worktree` opts into removing the git
 * worktree after cleanup succeeds. The chat row keeps a JSON snapshot so
 * unarchive can recreate and rebind that worktree.
 */
export const Migration0013ArchiveCleanup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const repositoryColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(repository_settings)
  `;
  const hasRepositoryColumn = (name: string): boolean =>
    repositoryColumns.some((column) => column.name === name);

  if (!hasRepositoryColumn("archive_cleanup_script")) {
    yield* sql`
      ALTER TABLE repository_settings
        ADD COLUMN archive_cleanup_script TEXT
    `;
  }

  if (!hasRepositoryColumn("archive_remove_worktree")) {
    yield* sql`
      ALTER TABLE repository_settings
        ADD COLUMN archive_remove_worktree INTEGER NOT NULL DEFAULT 0
    `;
  }

  const chatColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(chats)
  `;
  const hasChatColumn = (name: string): boolean =>
    chatColumns.some((column) => column.name === name);

  if (!hasChatColumn("archived_worktree_json")) {
    yield* sql`
      ALTER TABLE chats
        ADD COLUMN archived_worktree_json TEXT
    `;
  }
});
