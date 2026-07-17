import {
	Context,
	Crypto,
	Effect,
	Layer,
	PubSub,
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

export interface SessionDomainApi {
	readonly dispatch: (
		input: DispatchInput,
	) => Effect.Effect<CommandReceipt, SessionDomainError>;
	readonly catchUp: Effect.Effect<number, SessionDomainError>;
	readonly events: (input: {
		readonly streamId: string;
		readonly afterSequence?: number;
	}) => Stream.Stream<StoredEvent, SessionDomainError>;
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
	const projectorLock = yield* Semaphore.make(1);
	const catchUp = Semaphore.withPermits(projectorLock, 1, projector.catchUp());
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

	return SessionDomain.of({
		catchUp,
		events,
		allEvents,
		currentSequence: sql<{ readonly sequence: number }>`
			SELECT COALESCE(MAX(sequence), 0) AS sequence
			FROM events WHERE stream_kind = 'session'
		`.pipe(Effect.map((rows) => rows[0]?.sequence ?? 0)),
		dispatch: Effect.fn("SessionDomain.dispatch")(function* (
			input: DispatchInput,
		) {
			const receipt = yield* dispatch.dispatch(input);
			// Live consumers frequently resolve the full session read model after
			// receiving an event (for example, the project session-summary stream).
			// Make that read causally consistent: publishing before catch-up allowed
			// the consumer fiber to observe the new event while SQL still contained
			// the previous status, permanently emitting `idle` for a running turn.
			yield* catchUp;
			if (receipt.eventIds.length > 0) {
				const appended = yield* dispatchStorage.eventsInVersionRange(
					input.streamId,
					receipt.streamVersion - receipt.eventIds.length,
					receipt.streamVersion,
				);
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
