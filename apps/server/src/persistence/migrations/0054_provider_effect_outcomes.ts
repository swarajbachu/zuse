import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Distinguishes a completed reactor effect from a non-replayable provider
 * request that crossed its durable start fence but lost the process response.
 * Existing rows predate the fence and already represented completed effects.
 */
export const Migration0054ProviderEffectOutcomes = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`
		ALTER TABLE reactor_effect_receipts
		ADD COLUMN state TEXT NOT NULL DEFAULT 'completed'
		CHECK (state IN ('started', 'completed', 'outcome-unknown'))
	`;
	yield* sql`
		ALTER TABLE reactor_effect_receipts
		ADD COLUMN started_at TEXT
	`;
	yield* sql`
		UPDATE reactor_effect_receipts
		SET started_at = completed_at
		WHERE started_at IS NULL
	`;
});
