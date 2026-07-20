import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Persists explicit nearby-device blocks across desktop restarts. */
export const Migration0040BlockedNearbyDevices = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`
    CREATE TABLE blocked_nearby_devices (
      cryptographic_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    )
  `;
});
