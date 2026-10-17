import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
export const Migration0089DeviceBridgeEnrollment = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE device_bridge_enrollment (account_id TEXT PRIMARY KEY, secret TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1)`;
});
