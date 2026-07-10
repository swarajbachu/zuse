import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Completion markers for replay-safe reactor effects outside the event store. */
export const Migration0032ReactorEffectReceipts = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`
		CREATE TABLE reactor_effect_receipts (
			effect_id TEXT PRIMARY KEY,
			completed_at TEXT NOT NULL
		)
	`;
});
