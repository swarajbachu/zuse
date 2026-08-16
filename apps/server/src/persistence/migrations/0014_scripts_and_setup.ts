import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

export const Migration0014ScriptsAndSetup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const repositoryColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(repository_settings)
  `;
  const hasRepositoryColumn = (name: string): boolean =>
    repositoryColumns.some((column) => column.name === name);

  if (!hasRepositoryColumn("setup_script")) {
    yield* sql`ALTER TABLE repository_settings ADD COLUMN setup_script TEXT`;
  }
  if (!hasRepositoryColumn("run_script")) {
    yield* sql`ALTER TABLE repository_settings ADD COLUMN run_script TEXT`;
  }
  if (!hasRepositoryColumn("auto_run_after_setup")) {
    yield* sql`
      ALTER TABLE repository_settings
        ADD COLUMN auto_run_after_setup INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!hasRepositoryColumn("environment_variables_json")) {
    yield* sql`
      ALTER TABLE repository_settings
        ADD COLUMN environment_variables_json TEXT
    `;
  }

  const worktreeColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(worktrees)
  `;
  const hasWorktreeColumn = (name: string): boolean =>
    worktreeColumns.some((column) => column.name === name);

  if (!hasWorktreeColumn("setup_status")) {
    yield* sql`
      ALTER TABLE worktrees
        ADD COLUMN setup_status TEXT NOT NULL DEFAULT 'pending'
    `;
  }
  if (!hasWorktreeColumn("setup_output")) {
    yield* sql`
      ALTER TABLE worktrees
        ADD COLUMN setup_output TEXT NOT NULL DEFAULT ''
    `;
  }
  if (!hasWorktreeColumn("setup_started_at")) {
    yield* sql`ALTER TABLE worktrees ADD COLUMN setup_started_at TEXT`;
  }
  if (!hasWorktreeColumn("setup_finished_at")) {
    yield* sql`ALTER TABLE worktrees ADD COLUMN setup_finished_at TEXT`;
  }
});
