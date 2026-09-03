import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

const KEY = "cloud_storage_incarnation_id";

/**
 * Identity of the authoritative SQLite store. Process and gateway restarts
 * reuse it; a fresh/replaced database necessarily creates a different value.
 */
export const cloudStorageIncarnationId = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const existing = yield* sql<{ value: string }>`
		SELECT value FROM app_state WHERE key = ${KEY} LIMIT 1
	`;
	if (existing[0]?.value !== undefined) return existing[0].value;
	const created = crypto.randomUUID();
	yield* sql`
		INSERT INTO app_state (key, value) VALUES (${KEY}, ${created})
		ON CONFLICT(key) DO NOTHING
	`;
	const stored = yield* sql<{ value: string }>`
		SELECT value FROM app_state WHERE key = ${KEY} LIMIT 1
	`;
	return stored[0]?.value ?? created;
});
