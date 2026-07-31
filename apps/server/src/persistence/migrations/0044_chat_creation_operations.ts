import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Durable identity and workspace handoff for chat bootstrap. Keeping the
 * resolved worktree against the client operation id lets a lost acknowledgement
 * or process restart retry without creating a second branch/directory.
 */
export const Migration0044ChatCreationOperations = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`
		CREATE TABLE IF NOT EXISTS chat_creation_operations (
			operation_id TEXT PRIMARY KEY,
			chat_id TEXT NOT NULL UNIQUE,
			initial_session_id TEXT NOT NULL UNIQUE,
			project_id TEXT NOT NULL,
			provider_id TEXT NOT NULL,
			model TEXT NOT NULL,
			title TEXT,
			runtime_mode TEXT NOT NULL,
			permission_mode TEXT NOT NULL,
			tool_search INTEGER NOT NULL DEFAULT 0,
			prompt TEXT,
			startup_input_json TEXT,
			startup_queue_id TEXT,
			workspace_policy TEXT NOT NULL,
			worktree_id TEXT,
			status TEXT NOT NULL CHECK (
				status IN ('pending', 'creating_workspace', 'creating_chat', 'succeeded', 'failed')
			),
			error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`;
	yield* sql`
		CREATE INDEX IF NOT EXISTS idx_chat_creation_operations_project_status
		ON chat_creation_operations(project_id, status, updated_at)
	`;
});
