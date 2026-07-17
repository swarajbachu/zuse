import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { SessionEvent } from "../core/events.js";
import {
	type AppendInput,
	CommandReceipt,
	ConcurrencyConflict,
	type DispatchStorage,
	type StoredEvent,
} from "./dispatch.js";
import {
	decodePersistedEvent,
	type PersistedEventRow,
} from "./persisted-event.js";

export class DispatchPersistenceDecodeError extends Schema.TaggedErrorClass<DispatchPersistenceDecodeError>()(
	"DispatchPersistenceDecodeError",
	{
		recordKind: Schema.Literals(["event", "receipt"]),
		recordId: Schema.String,
		reason: Schema.String,
	},
) {}

export type SqlDispatchStorageError =
	| SqlError
	| ConcurrencyConflict
	| DispatchPersistenceDecodeError;

interface ReceiptRow {
	readonly command_id: string;
	readonly stream_id: string;
	readonly stream_version: number;
	readonly event_ids_json: string;
	readonly result_json: string | null;
}

const decodeSessionEvent = Schema.decodeUnknownEffect(
	Schema.fromJsonString(SessionEvent),
);
const decodeReceipt = Schema.decodeUnknownEffect(
	Schema.fromJsonString(CommandReceipt),
);
const decodeEventIds = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Array(Schema.String)),
);

const receiptDecodeError = (recordId: string, cause: unknown) =>
	new DispatchPersistenceDecodeError({
		recordKind: "receipt",
		recordId,
		reason: String(cause),
	});

const receiptFromRow = Effect.fn("SqlDispatchStorage.receiptFromRow")(
	function* (row: ReceiptRow) {
		if (row.result_json !== null) {
			return yield* decodeReceipt(row.result_json).pipe(
				Effect.mapError((cause) => receiptDecodeError(row.command_id, cause)),
			);
		}
		const eventIds = yield* decodeEventIds(row.event_ids_json).pipe(
			Effect.mapError((cause) => receiptDecodeError(row.command_id, cause)),
		);
		return {
			commandId: row.command_id,
			streamId: row.stream_id,
			streamVersion: row.stream_version,
			eventIds,
		};
	},
);

export type SqlDispatchStorageOptions<Event> = {
	readonly streamKind: string;
	readonly decodeEvent: (json: string) => Effect.Effect<Event, unknown>;
};

export interface SqlDispatchStorageApi<
	Event = SessionEvent,
	StorageError = SqlDispatchStorageError,
> extends DispatchStorage<StorageError, Event> {
	readonly eventsAfterSequence: (
		streamId: string,
		sequence: number,
	) => Effect.Effect<readonly StoredEvent<Event>[], StorageError>;
	readonly allEventsAfterSequence: (
		sequence: number,
	) => Effect.Effect<readonly StoredEvent<Event>[], StorageError>;
	readonly eventsInVersionRange: (
		streamId: string,
		fromExclusive: number,
		toInclusive: number,
	) => Effect.Effect<readonly StoredEvent<Event>[], StorageError>;
}

export const makeSqlDispatchStorage = <
	Event extends { readonly _tag: string } = SessionEvent,
>(
	sql: SqlClient.SqlClient,
	options?: SqlDispatchStorageOptions<Event>,
): SqlDispatchStorageApi<Event> => {
	const streamKind = options?.streamKind ?? "session";
	const decodeEvent =
		options?.decodeEvent ??
		((json: string) =>
			decodeSessionEvent(json) as unknown as Effect.Effect<Event, unknown>);
	const receipt = Effect.fn("SqlDispatchStorage.receipt")(function* (
		commandId: string,
	) {
		const rows = yield* sql<ReceiptRow>`
			SELECT command_id, stream_id, stream_version, event_ids_json, result_json
			FROM command_receipts
			WHERE command_id = ${commandId}
			LIMIT 1
		`;
		const row = rows[0];
		return row === undefined ? null : yield* receiptFromRow(row);
	});

	const decodeRows = (rows: ReadonlyArray<PersistedEventRow>) =>
		Effect.forEach(rows, (row) => decodePersistedEvent(row, decodeEvent));

	const events = Effect.fn("SqlDispatchStorage.events")(function* (
		streamId: string,
	) {
		const rows = yield* sql<PersistedEventRow>`
			SELECT sequence, event_id, correlation_id, causation_event_id,
			       stream_id, stream_version, payload_json
			FROM events
			WHERE stream_kind = ${streamKind} AND stream_id = ${streamId}
			ORDER BY stream_version ASC
		`;
		return yield* decodeRows(rows);
	});

	const eventsAfterSequence = Effect.fn(
		"SqlDispatchStorage.eventsAfterSequence",
	)(function* (streamId: string, sequence: number) {
		const rows = yield* sql<PersistedEventRow>`
			SELECT sequence, event_id, correlation_id, causation_event_id,
			       stream_id, stream_version, payload_json
			FROM events
			WHERE stream_kind = ${streamKind} AND stream_id = ${streamId}
			  AND sequence > ${sequence}
			ORDER BY sequence ASC
		`;
		return yield* decodeRows(rows);
	});

	const allEventsAfterSequence = Effect.fn(
		"SqlDispatchStorage.allEventsAfterSequence",
	)(function* (sequence: number) {
		const rows = yield* sql<PersistedEventRow>`
			SELECT sequence, event_id, correlation_id, causation_event_id,
			       stream_id, stream_version, payload_json
			FROM events
			WHERE stream_kind = ${streamKind} AND sequence > ${sequence}
			ORDER BY sequence ASC
		`;
		return yield* decodeRows(rows);
	});

	const eventsInVersionRange = Effect.fn(
		"SqlDispatchStorage.eventsInVersionRange",
	)(function* (streamId: string, fromExclusive: number, toInclusive: number) {
		const rows = yield* sql<PersistedEventRow>`
			SELECT sequence, event_id, correlation_id, causation_event_id,
			       stream_id, stream_version, payload_json
			FROM events
			WHERE stream_kind = ${streamKind} AND stream_id = ${streamId}
			  AND stream_version > ${fromExclusive}
			  AND stream_version <= ${toInclusive}
			ORDER BY stream_version ASC
		`;
		return yield* decodeRows(rows);
	});

	const append = Effect.fn("SqlDispatchStorage.append")(function* (
		input: AppendInput<Event>,
	) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				const existing = yield* receipt(input.commandId);
				if (existing !== null) return existing;

				const versions = yield* sql<{ readonly version: number }>`
					SELECT COALESCE(MAX(stream_version), 0) AS version
					FROM events
					WHERE stream_kind = ${streamKind} AND stream_id = ${input.streamId}
				`;
				const actualVersion = versions[0]?.version ?? 0;
				if (actualVersion !== input.expectedVersion) {
					return yield* new ConcurrencyConflict({
						streamId: input.streamId,
						expectedVersion: input.expectedVersion,
						actualVersion,
					});
				}

				const occurredAt = (yield* DateTime.nowAsDate).toISOString();
				let streamVersion = input.expectedVersion;
				for (const item of input.events) {
					streamVersion += 1;
					yield* sql`
						INSERT INTO events
							(event_id, correlation_id, causation_event_id, stream_kind,
							 stream_id, stream_version, type, occurred_at, actor, payload_json)
						VALUES
							(${item.eventId}, ${input.correlationId}, ${input.causationEventId},
							 ${streamKind}, ${input.streamId}, ${streamVersion}, ${item.event._tag},
							 ${occurredAt}, NULL, ${JSON.stringify(item.event)})
					`;
				}

				const result: CommandReceipt = {
					commandId: input.commandId,
					streamId: input.streamId,
					streamVersion,
					eventIds: input.events.map((item) => item.eventId),
				};
				yield* sql`
					INSERT INTO command_receipts
						(command_id, stream_kind, stream_id, stream_version,
						 event_ids_json, result_json, created_at)
					VALUES
						(${result.commandId}, ${streamKind}, ${result.streamId},
						 ${result.streamVersion}, ${JSON.stringify(result.eventIds)},
						 ${JSON.stringify(result)}, ${occurredAt})
				`;
				return result;
			}),
		);
	});

	return {
		receipt,
		events,
		eventsAfterSequence,
		allEventsAfterSequence,
		eventsInVersionRange,
		append,
	};
};

export class SqlDispatchStorage extends Context.Service<
	SqlDispatchStorage,
	DispatchStorage<SqlDispatchStorageError>
>()("zuse/domain/engine/SqlDispatchStorage") {
	static readonly layer: Layer.Layer<
		SqlDispatchStorage,
		never,
		SqlClient.SqlClient
	> = Layer.effect(
		SqlDispatchStorage,
		Effect.map(SqlClient.SqlClient, makeSqlDispatchStorage),
	);
}
