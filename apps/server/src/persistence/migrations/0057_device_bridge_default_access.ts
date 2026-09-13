import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Replace the initial opt-in default; command permissions remain mandatory. */
export const Migration0057DeviceBridgeDefaultAccess = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`UPDATE device_bridge_config SET enabled = 1`;
});
