import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { SessionEvent } from "../core/events.js";
import type { StoredEvent } from "./dispatch.js";
import {
	decodePersistedEvent,
	type PersistedEventRow,
} from "./persisted-event.js";
import type { ProjectorStorage } from "./projector-runner.js";
import type { DispatchPersistenceDecodeError } from "./sql-dispatch-storage.js";

type CursorRow = {
	readonly last_sequence: number;
};

const decodeSessionEvent = Schema.decodeUnknownEffect(
	Schema.fromJsonString(SessionEvent),
);

export type SqlConsumerStorageError = SqlError | DispatchPersistenceDecodeError;

export type SqlConsumerStorageOptions<Event> = {
	readonly streamKind: string;
	readonly decodeEvent: (json: string) => Effect.Effect<Event, unknown>;
};

export const makeSqlConsumerStorage = <Event = SessionEvent>(
	sql: SqlClient.SqlClient,
	options?: SqlConsumerStorageOptions<Event>,
): ProjectorStorage<StoredEvent<Event>, SqlConsumerStorageError> => {
	const streamKind = options?.streamKind ?? "session";
	const decodeEvent =
		options?.decodeEvent ??
		((json: string) =>
			decodeSessionEvent(json) as unknown as Effect.Effect<Event, unknown>);
	const cursor = Effect.fn("SqlConsumerStorage.cursor")(function* (
		consumerName: string,
	) {
		const rows = yield* sql<CursorRow>`
			SELECT last_sequence
			FROM projector_cursors
			WHERE projector_name = ${consumerName}
			LIMIT 1
		`;
		return rows[0]?.last_sequence ?? 0;
	});

	const eventsAfter = Effect.fn("SqlConsumerStorage.eventsAfter")(function* (
		sequence: number,
	) {
		const rows = yield* sql<PersistedEventRow>`
			SELECT sequence, event_id, correlation_id, causation_event_id,
			       stream_id, stream_version, payload_json
			FROM events
			WHERE stream_kind = ${streamKind} AND sequence > ${sequence}
			ORDER BY sequence ASC
		`;

		return yield* Effect.forEach(rows, (row) =>
			decodePersistedEvent(row, decodeEvent),
		);
	});

	const commitCursor = Effect.fn("SqlConsumerStorage.commitCursor")(function* (
		consumerName: string,
		sequence: number,
	) {
		const updatedAt = (yield* DateTime.nowAsDate).toISOString();
		yield* sql`
			INSERT INTO projector_cursors
				(projector_name, last_sequence, updated_at)
			VALUES
				(${consumerName}, ${sequence}, ${updatedAt})
			ON CONFLICT(projector_name) DO UPDATE SET
				last_sequence = MAX(projector_cursors.last_sequence, excluded.last_sequence),
				updated_at = excluded.updated_at
		`;
	});

	const applyAndCommit = Effect.fn("SqlConsumerStorage.applyAndCommit")(
		function* <ApplyError, ApplyRequirements>(
			projectorName: string,
			sequence: number,
			apply: Effect.Effect<void, ApplyError, ApplyRequirements>,
		) {
			yield* sql.withTransaction(
				Effect.gen(function* () {
					yield* apply;
					yield* commitCursor(projectorName, sequence);
				}),
			);
		},
	);

	return { cursor, eventsAfter, commitCursor, applyAndCommit };
};

export class SqlConsumerStorage extends Context.Service<
	SqlConsumerStorage,
	ProjectorStorage<StoredEvent, SqlConsumerStorageError>
>()("zuse/domain/engine/SqlConsumerStorage") {
	static readonly layer: Layer.Layer<
		SqlConsumerStorage,
		never,
		SqlClient.SqlClient
	> = Layer.effect(
		SqlConsumerStorage,
		Effect.map(SqlClient.SqlClient, makeSqlConsumerStorage),
	);
}
