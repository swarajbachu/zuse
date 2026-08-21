import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Repairs operations written by a pre-durable-lifecycle runtime after
 * migration 0050 had already added the new columns. Those writers only set
 * the legacy `status`, leaving `phase` at its default (`persisted`). The new
 * renderer then mistakes completed chats for interrupted creation work.
 */
export const Migration0051LegacyChatCreationPhaseRepair = Effect.gen(
	function* () {
		const sql = yield* SqlClient.SqlClient;
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
			WHERE request_fingerprint IS NULL
			  AND phase != CASE status
				WHEN 'pending' THEN 'persisted'
				WHEN 'creating_workspace' THEN 'creating_workspace'
				WHEN 'creating_chat' THEN 'starting_agent'
				WHEN 'succeeded' THEN 'running'
				ELSE 'failed'
			  END
		`;
	},
);
