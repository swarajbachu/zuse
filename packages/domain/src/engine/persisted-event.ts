import { Effect } from "effect";

import type { StoredEvent } from "./dispatch.js";
import { DispatchPersistenceDecodeError } from "./sql-dispatch-storage.js";

export interface PersistedEventRow {
	readonly sequence: number;
	readonly event_id: string;
	readonly correlation_id: string | null;
	readonly causation_event_id: string | null;
	readonly stream_id: string;
	readonly stream_version: number;
	readonly payload_json: string;
}

export const decodePersistedEvent = <Event>(
	row: PersistedEventRow,
	decodeEvent: (json: string) => Effect.Effect<Event, unknown>,
): Effect.Effect<StoredEvent<Event>, DispatchPersistenceDecodeError> =>
	decodeEvent(row.payload_json).pipe(
		Effect.map((event) => ({
			eventId: row.event_id,
			correlationId: row.correlation_id ?? row.event_id,
			causationEventId: row.causation_event_id,
			streamId: row.stream_id,
			streamVersion: row.stream_version,
			sequence: row.sequence,
			event,
		})),
		Effect.mapError(
			(cause) =>
				new DispatchPersistenceDecodeError({
					recordKind: "event",
					recordId: row.event_id,
					reason: String(cause),
				}),
		),
	);
