import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Lets Zot snapshots find a repository's running turns and unanswered
 * permission requests by seeking only those event types, instead of reading
 * every event of every session on each poll.
 */
export const Migration0091MasterEventIndex = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE INDEX IF NOT EXISTS idx_events_kind_type_stream ON events(stream_kind, type, stream_id, sequence)`;
});
