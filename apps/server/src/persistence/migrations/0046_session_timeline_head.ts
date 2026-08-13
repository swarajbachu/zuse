import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Materialized active-turn state used by bounded timeline snapshots. */
export const Migration0046SessionTimelineHead = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`ALTER TABLE sessions ADD COLUMN current_turn_id TEXT`;
	yield* sql`ALTER TABLE sessions ADD COLUMN current_turn_phase TEXT`;
	yield* sql`
		INSERT OR IGNORE INTO app_state (key, value)
		VALUES ('session_stream_epoch', lower(hex(randomblob(16))))
	`;
	// Preserve an in-flight turn across upgrade. The normal projector owns all
	// subsequent transitions.
	yield* sql`
		UPDATE sessions
		SET current_turn_id = (
				SELECT json_extract(payload_json, '$.turnId') FROM events
				WHERE stream_kind = 'session' AND stream_id = sessions.id
					AND type IN ('TurnStarted', 'TurnInterruptRequested',
						'TurnInterruptAcknowledged', 'TurnInterruptFailed', 'TurnSettled')
				ORDER BY stream_version DESC LIMIT 1
			),
			current_turn_phase = CASE (
				SELECT type FROM events
				WHERE stream_kind = 'session' AND stream_id = sessions.id
					AND type IN ('TurnStarted', 'TurnInterruptRequested',
						'TurnInterruptAcknowledged', 'TurnInterruptFailed', 'TurnSettled')
				ORDER BY stream_version DESC LIMIT 1
			)
				WHEN 'TurnStarted' THEN 'running'
				WHEN 'TurnInterruptRequested' THEN 'interrupt-requested'
				WHEN 'TurnInterruptAcknowledged' THEN 'interrupt-acknowledged'
				WHEN 'TurnInterruptFailed' THEN 'running'
				ELSE NULL
			END
		WHERE status = 'running'
	`;
	yield* sql`
		UPDATE sessions SET current_turn_id = NULL
		WHERE current_turn_phase IS NULL
	`;
});
