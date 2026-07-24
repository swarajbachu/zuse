import {
	Context,
	Crypto,
	Effect,
	Layer,
	PubSub,
	Result,
	Schedule,
	Semaphore,
	Stream,
} from "effect";
import type { PlatformError } from "effect/PlatformError";
import { SqlClient } from "effect/unstable/sql";

import {
	makeSqlSessionProjector,
	type SqlSessionProjectorError,
} from "../projectors/sql-session-projector.js";
import {
	type CommandReceipt,
	DispatchEngine,
	type DispatchFailure,
	type DispatchInput,
	type StoredEvent,
} from "./dispatch.js";
import { ProjectorRunner } from "./projector-runner.js";
import {
	makeSqlConsumerStorage,
	type SqlConsumerStorageError,
} from "./sql-consumer-storage.js";
import {
	makeSqlDispatchStorage,
	type SqlDispatchStorageError,
} from "./sql-dispatch-storage.js";

export type SessionDomainError =
	| DispatchFailure<SqlDispatchStorageError>
	| SqlConsumerStorageError
	| SqlSessionProjectorError
	| PlatformError;

export type SessionSynchronizationRecord =
	| {
			readonly kind: "snapshot";
			readonly throughVersion: number;
			readonly events: readonly StoredEvent[];
	  }
	| { readonly kind: "event"; readonly record: StoredEvent }
	| { readonly kind: "synchronized"; readonly throughVersion: number };

export interface SessionDomainApi {
	readonly dispatch: (
		input: DispatchInput,
	) => Effect.Effect<CommandReceipt, SessionDomainError>;
	readonly catchUp: Effect.Effect<number, SessionDomainError>;
	readonly events: (input: {
		readonly streamId: string;
		readonly afterSequence?: number;
	}) => Stream.Stream<StoredEvent, SessionDomainError>;
	readonly synchronizedEvents: (input: {
		readonly streamId: string;
		readonly afterVersion?: number;
		readonly hasProjection?: boolean;
		readonly snapshotGap?: number;
	}) => Stream.Stream<SessionSynchronizationRecord, SessionDomainError>;
	readonly allEvents: (input: {
		readonly afterSequence?: number;
	}) => Stream.Stream<StoredEvent, SessionDomainError>;
	readonly currentSequence: Effect.Effect<number, SessionDomainError>;
}

export class SessionDomain extends Context.Service<
	SessionDomain,
	SessionDomainApi
>()("zuse/domain/engine/SessionDomain") {
	static readonly layer: Layer.Layer<
		SessionDomain,
		never,
		SqlClient.SqlClient | Crypto.Crypto
	> = Layer.effect(
		SessionDomain,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const crypto = yield* Crypto.Crypto;
			return yield* makeSessionDomain(sql, () => crypto.randomUUIDv7);
		}),
	);
}

export const makeSessionDomain = Effect.fn("SessionDomain.make")(function* (
	sql: SqlClient.SqlClient,
	makeEventId: () => Effect.Effect<string, PlatformError>,
) {
	const dispatchStorage = makeSqlDispatchStorage(sql);
	const dispatch = new DispatchEngine(dispatchStorage, makeEventId);
	const projector = new ProjectorRunner(
		makeSqlConsumerStorage(sql),
		makeSqlSessionProjector(sql),
	);
	const transactionalProjector = makeSqlSessionProjector(sql);
	const projectorLock = yield* Semaphore.make(1);
	const catchUp = Semaphore.withPermits(projectorLock, 1, projector.catchUp());
	const commandLocks = new Map<string, Semaphore.Semaphore>();
	const commandLock = (streamId: string): Semaphore.Semaphore => {
		const existing = commandLocks.get(streamId);
		if (existing !== undefined) return existing;
		const created = Semaphore.makeUnsafe(1);
		commandLocks.set(streamId, created);
		return created;
	};
	const eventHub = yield* PubSub.unbounded<StoredEvent>();

	const events: SessionDomainApi["events"] = ({
		streamId,
		afterSequence = 0,
	}) =>
		Stream.unwrap(
			Effect.gen(function* () {
				const subscription = yield* PubSub.subscribe(eventHub);
				const replay = yield* dispatchStorage.eventsAfterSequence(
					streamId,
					afterSequence,
				);
				let cursor = afterSequence;
				return Stream.concat(
					Stream.fromIterable(replay),
					Stream.fromSubscription(subscription),
				).pipe(
					Stream.filter((record) => {
						if (record.streamId !== streamId || record.sequence <= cursor) {
							return false;
						}
						cursor = record.sequence;
						return true;
					}),
				);
			}),
		);

	const allEvents: SessionDomainApi["allEvents"] = ({ afterSequence = 0 }) =>
		Stream.unwrap(
			Effect.gen(function* () {
				const subscription = yield* PubSub.subscribe(eventHub);
				const replay =
					yield* dispatchStorage.allEventsAfterSequence(afterSequence);
				let cursor = afterSequence;
				return Stream.concat(
					Stream.fromIterable(replay),
					Stream.fromSubscription(subscription),
				).pipe(
					Stream.filter((record) => {
						if (record.sequence <= cursor) return false;
						cursor = record.sequence;
						return true;
					}),
				);
			}),
		);

	const synchronizedEvents: SessionDomainApi["synchronizedEvents"] = ({
		streamId,
		afterVersion,
		hasProjection = false,
		snapshotGap = 1_000,
	}) =>
		Stream.unwrap(
			Effect.gen(function* () {
				// Attach live delivery before observing the durable head. Events that
				// commit during snapshot/replay are retained by this subscription.
				const subscription = yield* PubSub.subscribe(eventHub);
				const captured = yield* dispatchStorage.events(streamId);
				const throughVersion =
					captured[captured.length - 1]?.streamVersion ?? 0;
				const retainedVersion = afterVersion ?? 0;
				const needsSnapshot =
					!hasProjection ||
					afterVersion === undefined ||
					retainedVersion > throughVersion ||
					throughVersion - retainedVersion > snapshotGap;
				const prefix: SessionSynchronizationRecord[] = needsSnapshot
					? [{ kind: "snapshot", throughVersion, events: captured }]
					: captured
							.filter((record) => record.streamVersion > retainedVersion)
							.map((record) => ({ kind: "event" as const, record }));
				prefix.push({ kind: "synchronized", throughVersion });
				let liveVersion = throughVersion;
				return Stream.concat(
					Stream.fromIterable(prefix),
					Stream.fromSubscription(subscription).pipe(
						Stream.filterMap((record) => {
							if (
								record.streamId !== streamId ||
								record.streamVersion <= liveVersion
							) {
								return Result.fail(undefined);
							}
							liveVersion = record.streamVersion;
							return Result.succeed({
								kind: "event" as const,
								record,
							});
						}),
					),
				);
			}),
		);

	return SessionDomain.of({
		catchUp,
		events,
		allEvents,
		synchronizedEvents,
		currentSequence: sql<{ readonly sequence: number }>`
			SELECT COALESCE(MAX(sequence), 0) AS sequence
			FROM events WHERE stream_kind = 'session'
		`.pipe(Effect.map((rows) => rows[0]?.sequence ?? 0)),
		dispatch: Effect.fn("SessionDomain.dispatch")(function* (
			input: DispatchInput,
		) {
			const { receipt, appended } = yield* Semaphore.withPermits(
				commandLock(input.streamId),
				1,
				sql.withTransaction(
					Effect.gen(function* () {
						const receipt = yield* dispatch.dispatch(input).pipe(
							Effect.retry({
								while: (error) => error._tag === "ConcurrencyConflict",
								schedule: Schedule.recurs(8),
							}),
						);
						const appended =
							receipt.eventIds.length === 0
								? []
								: yield* dispatchStorage.eventsInVersionRange(
										input.streamId,
										receipt.streamVersion - receipt.eventIds.length,
										receipt.streamVersion,
									);
						const cursorRows = yield* sql<{ readonly last_sequence: number }>`
							SELECT last_sequence FROM projector_cursors
							WHERE projector_name = ${transactionalProjector.name}
							LIMIT 1
						`;
						let cursor = cursorRows[0]?.last_sequence ?? 0;
						for (const record of appended) {
							if (record.sequence <= cursor) continue;
							yield* transactionalProjector.apply(record);
							cursor = record.sequence;
							yield* sql`
								INSERT INTO projector_cursors
									(projector_name, last_sequence, updated_at)
								VALUES
									(${transactionalProjector.name}, ${cursor}, ${new Date().toISOString()})
								ON CONFLICT(projector_name) DO UPDATE SET
									last_sequence = MAX(projector_cursors.last_sequence, excluded.last_sequence),
									updated_at = excluded.updated_at
							`;
						}
						return { receipt, appended };
					}),
				),
			);
			if (appended.length > 0) {
				yield* Effect.forEach(
					appended,
					(record) => PubSub.publish(eventHub, record),
					{ discard: true },
				);
			}
			return receipt;
		}),
	});
});
