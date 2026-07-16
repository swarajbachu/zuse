import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Durable native-provider replay cursor; null preserves legacy full replay. */
export const Migration0037ProviderEventCursor = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`ALTER TABLE sessions ADD COLUMN provider_event_cursor TEXT`;
});
