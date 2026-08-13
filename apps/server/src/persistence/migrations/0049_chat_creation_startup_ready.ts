import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Records whether a chat's startup input is complete and may be drained.
 * Plain-text creates are immediately ready; attachment/context preparation
 * explicitly holds the durable queue item until its final update.
 */
export const Migration0049ChatCreationStartupReady = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`
		ALTER TABLE chat_creation_operations
		ADD COLUMN startup_ready INTEGER NOT NULL DEFAULT 1
	`;
});
