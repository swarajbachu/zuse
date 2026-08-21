import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Turns the coarse chat bootstrap receipt into a resumable lifecycle.
 *
 * `status` remains for one compatibility release. New code owns `phase`; the
 * deterministic backfill below prevents restart recovery from guessing based
 * on filesystem state while the schema is being upgraded.
 */
export const Migration0050DurableChatCreation = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`ALTER TABLE chat_creation_operations ADD COLUMN phase TEXT NOT NULL DEFAULT 'persisted'`;
	yield* sql`ALTER TABLE chat_creation_operations ADD COLUMN failure_stage TEXT`;
	yield* sql`ALTER TABLE chat_creation_operations ADD COLUMN retryable INTEGER NOT NULL DEFAULT 1`;
	yield* sql`ALTER TABLE chat_creation_operations ADD COLUMN workspace_attempt INTEGER NOT NULL DEFAULT 0`;
	yield* sql`ALTER TABLE chat_creation_operations ADD COLUMN setup_attempt INTEGER NOT NULL DEFAULT 0`;
	yield* sql`ALTER TABLE chat_creation_operations ADD COLUMN provider_attempt INTEGER NOT NULL DEFAULT 0`;
	yield* sql`ALTER TABLE chat_creation_operations ADD COLUMN setup_bypassed INTEGER NOT NULL DEFAULT 0`;
	yield* sql`ALTER TABLE chat_creation_operations ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 0`;
	yield* sql`ALTER TABLE chat_creation_operations ADD COLUMN fingerprint_version INTEGER NOT NULL DEFAULT 1`;
	yield* sql`ALTER TABLE chat_creation_operations ADD COLUMN request_fingerprint TEXT`;
	yield* sql`ALTER TABLE chat_creation_operations ADD COLUMN phase_started_at TEXT`;
	yield* sql`
		UPDATE chat_creation_operations
		SET phase = CASE status
			WHEN 'pending' THEN 'persisted'
			WHEN 'creating_workspace' THEN 'creating_workspace'
			WHEN 'creating_chat' THEN 'starting_agent'
			WHEN 'succeeded' THEN 'running'
			ELSE 'failed'
		END,
		failure_stage = CASE WHEN status = 'failed' THEN 'legacy_unknown' ELSE NULL END,
		retryable = CASE WHEN status = 'failed' THEN 0 ELSE 1 END,
		phase_started_at = COALESCE(phase_started_at, updated_at)
	`;
	yield* sql`
		CREATE INDEX IF NOT EXISTS idx_chat_creation_operations_project_phase
		ON chat_creation_operations(project_id, phase, updated_at)
	`;
	yield* sql`
		CREATE TABLE IF NOT EXISTS git_pr_notification_claims (
			identity TEXT PRIMARY KEY,
			claimed_at TEXT NOT NULL
		)
	`;
});
