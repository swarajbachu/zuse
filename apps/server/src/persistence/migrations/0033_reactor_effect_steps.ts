import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Durable step state for non-transactional reactor effects. */
export const Migration0033ReactorEffectSteps = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`
		CREATE TABLE reactor_effect_steps (
			effect_id TEXT NOT NULL,
			step TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('started', 'completed')),
			detail_json TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (effect_id, step)
		)
	`;
});
