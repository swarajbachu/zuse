import { DateTime, Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { SessionEvent } from "../core/events.js";
import {
	type AppendInput,
	type CommandReceipt,
	ConcurrencyConflict,
	type DispatchStorage,
	type StoredEvent,
} from "./dispatch.js";

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
}

interface EventRow {
	readonly sequence: number;
	readonly event_id: string;
	readonly correlation_id: string;
	readonly causation_event_id: string | null;
	readonly stream_id: string;
	readonly stream_version: number;
	readonly payload_json: string;
}

const decodeEvent = Schema.decodeUnknownEffect(
	Schema.fromJsonString(SessionEvent),
);

const receiptFromRow = (
	row: ReceiptRow,
): Effect.Effect<CommandReceipt, DispatchPersistenceDecodeError> =>
	Effect.try({
		try: () => {
			const eventIds = JSON.parse(row.event_ids_json) as unknown;
			if (
				!Array.isArray(eventIds) ||
				!eventIds.every((eventId) => typeof eventId === "string")
			) {
				throw new Error("event_ids_json must be an array of strings");
			}
			return {
				commandId: row.command_id,
				streamId: row.stream_id,
				streamVersion: row.stream_version,
				eventIds,
			};
		},
		catch: (cause) =>
			new DispatchPersistenceDecodeError({
				recordKind: "receipt",
				recordId: row.command_id,
				reason: cause instanceof Error ? cause.message : String(cause),
			}),
	});

export const makeSqlDispatchStorage = (
	sql: SqlClient.SqlClient,
): DispatchStorage<SqlDispatchStorageError> => {
	const receipt = Effect.fn("SqlDispatchStorage.receipt")(function* (
		commandId: string,
	) {
		const rows = yield* sql<ReceiptRow>`
			SELECT command_id, stream_id, stream_version, event_ids_json
			FROM command_receipts
			WHERE command_id = ${commandId}
			LIMIT 1
		`;
		const row = rows[0];
		return row === undefined ? null : yield* receiptFromRow(row);
	});

	const events = Effect.fn("SqlDispatchStorage.events")(function* (
		streamId: string,
	) {
		const rows = yield* sql<EventRow>`
			SELECT sequence, event_id, correlation_id, causation_event_id,
			       stream_id, stream_version, payload_json
			FROM events
			WHERE stream_kind = 'session' AND stream_id = ${streamId}
			ORDER BY stream_version ASC
		`;
		return yield* Effect.forEach(
			rows,
			(row): Effect.Effect<StoredEvent, DispatchPersistenceDecodeError> =>
				decodeEvent(row.payload_json).pipe(
					Effect.map((event) => ({
						eventId: row.event_id,
						correlationId: row.correlation_id,
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
				),
		);
	});

	const append = Effect.fn("SqlDispatchStorage.append")(function* (
		input: AppendInput,
	) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				const existing = yield* receipt(input.commandId);
				if (existing !== null) return existing;

				const versions = yield* sql<{ readonly version: number }>`
					SELECT COALESCE(MAX(stream_version), 0) AS version
					FROM events
					WHERE stream_kind = 'session' AND stream_id = ${input.streamId}
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
							 'session', ${input.streamId}, ${streamVersion}, ${item.event._tag},
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
						(${result.commandId}, 'session', ${result.streamId},
						 ${result.streamVersion}, ${JSON.stringify(result.eventIds)},
						 NULL, ${occurredAt})
				`;
				return result;
			}),
		);
	});

	return { receipt, events, append };
};
