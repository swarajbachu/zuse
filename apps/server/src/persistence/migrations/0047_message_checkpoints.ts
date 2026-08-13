import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Durable high-water marks for cumulative provider text checkpoints. */
export const Migration0047MessageCheckpoints = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`ALTER TABLE messages ADD COLUMN checkpoint_revision INTEGER`;
	yield* sql`ALTER TABLE messages ADD COLUMN checkpoint_final INTEGER`;
	// Rebuild checkpoint state when upgrading a database that already accepted
	// checkpoint-bearing events before this projection metadata existed.
	yield* sql`
		UPDATE messages
		SET checkpoint_revision = (
				SELECT CAST(json_extract(events.payload_json, '$.checkpointRevision') AS INTEGER)
				FROM events
				WHERE events.stream_kind = 'session'
					AND events.stream_id = messages.session_id
					AND events.type = 'MessagePersisted'
					AND json_extract(events.payload_json, '$.messageId') = messages.id
					AND json_type(events.payload_json, '$.checkpointRevision') = 'integer'
				ORDER BY events.stream_version DESC LIMIT 1
			),
			checkpoint_final = (
				SELECT CASE json_extract(events.payload_json, '$.checkpointFinal')
					WHEN 1 THEN 1 ELSE 0 END
				FROM events
				WHERE events.stream_kind = 'session'
					AND events.stream_id = messages.session_id
					AND events.type = 'MessagePersisted'
					AND json_extract(events.payload_json, '$.messageId') = messages.id
					AND json_type(events.payload_json, '$.checkpointRevision') = 'integer'
				ORDER BY events.stream_version DESC LIMIT 1
			)
		WHERE EXISTS (
			SELECT 1 FROM events
			WHERE events.stream_kind = 'session'
				AND events.stream_id = messages.session_id
				AND events.type = 'MessagePersisted'
				AND json_extract(events.payload_json, '$.messageId') = messages.id
				AND json_type(events.payload_json, '$.checkpointRevision') = 'integer'
		)
	`;
});
