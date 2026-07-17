import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const Migration0038QueuedMessageReady = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const columns = yield* sql<{ readonly name: string }>`
		PRAGMA table_info(queued_messages)
	`;
	if (!columns.some((column) => column.name === "ready")) {
		yield* sql`
			ALTER TABLE queued_messages
			ADD COLUMN ready INTEGER NOT NULL DEFAULT 1
		`;
	}
});
