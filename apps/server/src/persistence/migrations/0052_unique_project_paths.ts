import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * New registrations persist filesystem-canonical paths. Consolidate any exact
 * duplicates written by older overlapping imports, then let SQLite arbitrate
 * concurrent registrations across runtimes and processes.
 *
 * Case-only paths intentionally remain distinct: they may identify different
 * directories on a case-sensitive filesystem. Workspace registration resolves
 * legacy aliases through the filesystem before attempting an insert.
 */
export const Migration0052UniqueProjectPaths = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;

	yield* sql`
		CREATE TEMP TABLE project_path_duplicates AS
		SELECT
			project.id AS duplicate_id,
			(
				SELECT keeper.id
				FROM projects AS keeper
				WHERE keeper.path = project.path
				ORDER BY keeper.created_at ASC, keeper.id ASC
				LIMIT 1
			) AS keeper_id
		FROM projects AS project
		WHERE project.id != (
			SELECT keeper.id
			FROM projects AS keeper
			WHERE keeper.path = project.path
			ORDER BY keeper.created_at ASC, keeper.id ASC
			LIMIT 1
		)
	`;

	// Settings are one-to-one. Prefer the keeper's row when both exist.
	yield* sql`
		DELETE FROM repository_settings
		WHERE project_id IN (SELECT duplicate_id FROM project_path_duplicates)
		  AND EXISTS (
			SELECT 1
			FROM project_path_duplicates AS duplicate
			INNER JOIN repository_settings AS keeper_settings
				ON keeper_settings.project_id = duplicate.keeper_id
			WHERE duplicate.duplicate_id = repository_settings.project_id
		  )
	`;
	yield* sql`
		UPDATE repository_settings
		SET project_id = (
			SELECT keeper_id FROM project_path_duplicates
			WHERE duplicate_id = repository_settings.project_id
		)
		WHERE project_id IN (SELECT duplicate_id FROM project_path_duplicates)
	`;

	// A duplicated project can also have the same worktree path registered.
	// Keep the keeper project's row and let ON DELETE SET NULL clear references
	// to the redundant worktree before the duplicate project is removed.
	yield* sql`
		DELETE FROM worktrees
		WHERE project_id IN (SELECT duplicate_id FROM project_path_duplicates)
		  AND EXISTS (
			SELECT 1
			FROM project_path_duplicates AS duplicate
			INNER JOIN worktrees AS keeper_worktree
				ON keeper_worktree.project_id = duplicate.keeper_id
				AND keeper_worktree.path = worktrees.path
			WHERE duplicate.duplicate_id = worktrees.project_id
		  )
	`;
	yield* sql`
		UPDATE worktrees
		SET project_id = (
			SELECT keeper_id FROM project_path_duplicates
			WHERE duplicate_id = worktrees.project_id
		)
		WHERE project_id IN (SELECT duplicate_id FROM project_path_duplicates)
	`;

	yield* sql`
		UPDATE sessions
		SET project_id = (
			SELECT keeper_id FROM project_path_duplicates
			WHERE duplicate_id = sessions.project_id
		)
		WHERE project_id IN (SELECT duplicate_id FROM project_path_duplicates)
	`;
	yield* sql`
		UPDATE chats
		SET project_id = (
			SELECT keeper_id FROM project_path_duplicates
			WHERE duplicate_id = chats.project_id
		)
		WHERE project_id IN (SELECT duplicate_id FROM project_path_duplicates)
	`;
	yield* sql`
		UPDATE permission_decisions
		SET project_id = (
			SELECT keeper_id FROM project_path_duplicates
			WHERE duplicate_id = permission_decisions.project_id
		)
		WHERE project_id IN (SELECT duplicate_id FROM project_path_duplicates)
	`;
	yield* sql`
		UPDATE chat_creation_operations
		SET project_id = (
			SELECT keeper_id FROM project_path_duplicates
			WHERE duplicate_id = chat_creation_operations.project_id
		)
		WHERE project_id IN (SELECT duplicate_id FROM project_path_duplicates)
	`;

	yield* sql`
		UPDATE app_state
		SET value = (
			SELECT keeper_id FROM project_path_duplicates
			WHERE duplicate_id = app_state.value
		)
		WHERE key = 'selectedProjectId'
		  AND value IN (SELECT duplicate_id FROM project_path_duplicates)
	`;
	yield* sql`
		DELETE FROM projects
		WHERE id IN (SELECT duplicate_id FROM project_path_duplicates)
	`;
	yield* sql`DROP TABLE project_path_duplicates`;
	yield* sql`CREATE UNIQUE INDEX idx_projects_path_unique ON projects(path)`;
});
