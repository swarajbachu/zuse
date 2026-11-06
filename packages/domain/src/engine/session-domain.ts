import type {
	AgentSessionId,
	JobId,
	Message,
	SessionId,
	SessionTimelineProjection,
} from "@zuse/contracts";
import {
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	PubSub,
	Result,
	Schedule,
	Semaphore,
	Stream,
} from "effect";
import type { PlatformError } from "effect/PlatformError";
import { SqlClient } from "effect/unstable/sql";
import {
	type JobLedger,
	type JobLedgerError,
	makeSqlJobLedger,
} from "../agent-engine/job-ledger.js";
import { jobsForSessionEvent } from "../agent-engine/jobs.js";
import {
	ACTIVE_SESSION_TURN_STATUSES,
	makeSqlSessionProjector,
	type SqlSessionProjectorError,
} from "../projectors/sql-session-projector.js";
import {
	MAX_TIMELINE_SNAPSHOT_PROJECTION_BYTES,
	readSessionTimelineMessagePage,
	readSessionTimelineSnapshot,
	type SessionTimelineMessagePage,
	type SessionTimelineSnapshot,
} from "../queries/session-timeline-snapshot.js";
import type { SqlSessionQueryError } from "../queries/sql-session-queries.js";
import {
	AdmissionClosed,
	makeSqlAdmission,
	type SqlAdmission,
} from "./admission.js";
import {
	type AttemptOwnership,
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
	DispatchPersistenceDecodeError,
	makeSqlDispatchStorage,
	type SqlDispatchStorageError,
} from "./sql-dispatch-storage.js";

export type SessionDomainError =
	| AdmissionClosed
	| DispatchFailure<SqlDispatchStorageError>
	| JobLedgerError
	| DispatchFailure<SqlDispatchStorageError>
	| SqlConsumerStorageError
	| SqlSessionProjectorError
	| SqlSessionQueryError
	| PlatformError;

export type SessionSynchronizationRecord =
	| {
			readonly kind: "snapshot";
			readonly streamEpoch: string;
			readonly throughVersion: number;
			readonly projection: SessionTimelineProjection;
			readonly olderMessageSequence: number | null;
			readonly totalMessageCount: number;
			readonly historyMode?: "background";
	  }
	| {
			readonly kind: "snapshot-chunk";
			readonly streamEpoch: string;
			readonly throughVersion: number;
			readonly messages: readonly Message[];
			readonly olderMessageSequence: number | null;
	  }
	| {
			readonly kind: "event";
			readonly streamEpoch: string;
			readonly record: StoredEvent;
	  }
	| {
			readonly kind: "synchronized";
			readonly streamEpoch: string;
			readonly throughVersion: number;
	  }
	| {
			readonly kind: "reset-required";
			readonly streamEpoch: string;
			readonly throughVersion: number;
			readonly reason: "restored" | "compacted" | "cursor-invalid";
	  };

export interface SessionDomainApi {
	readonly admission: SqlAdmission;
	readonly providerReservation: (
		streamId: string,
	) => Effect.Effect<string | null, SessionDomainError>;
	readonly activeAttempt: (
		streamId: string,
	) => Effect.Effect<AttemptOwnership | null, SessionDomainError>;
	readonly dispatch: (
		input: DispatchInput,
	) => Effect.Effect<CommandReceipt, SessionDomainError>;
	readonly dispatchTransactionally: <A, E, R>(
		input: DispatchInput,
		onCommitted: (receipt: CommandReceipt) => Effect.Effect<A, E, R>,
	) => Effect.Effect<A, SessionDomainError | E, R>;
	readonly catchUp: Effect.Effect<number, SessionDomainError>;
	readonly events: (input: {
		readonly streamId: string;
		readonly afterSequence?: number;
	}) => Stream.Stream<StoredEvent, SessionDomainError>;
	readonly synchronizedEvents: (input: {
		readonly streamId: string;
		readonly afterVersion?: number;
		readonly streamEpoch?: string;
		readonly hasProjection?: boolean;
		readonly deferToolDetails?: boolean;
		readonly historyMode?: "background";
		readonly maxDeltaEvents?: number;
		readonly maxDeltaBytes?: number;
	}) => Stream.Stream<SessionSynchronizationRecord, SessionDomainError>;
	readonly allEvents: (input: {
		readonly afterSequence?: number;
	}) => Stream.Stream<StoredEvent, SessionDomainError>;
	readonly currentSequence: Effect.Effect<number, SessionDomainError>;
	readonly streamEpoch: string;
	readonly currentStreamVersion: (
		streamId: string,
	) => Effect.Effect<number, SessionDomainError>;
	readonly timelineSnapshot: (
		streamId: SessionId,
	) => Effect.Effect<SessionTimelineSnapshot, SessionDomainError>;
	readonly timelineMessagePage: (
		streamId: AgentSessionId,
		beforeSequence: number,
		limit?: number,
	) => Effect.Effect<SessionTimelineMessagePage, SessionDomainError>;
	/**
	 * Durable jobs implied by committed session events. Rows are inserted in
	 * the command transaction; `jobWakeups` fires after commit so a worker can
	 * claim them without polling.
	 */
	readonly jobs: JobLedger;
	readonly jobWakeups: PubSub.PubSub<void>;
	readonly jobCancellations: PubSub.PubSub<ReadonlyArray<JobId>>;
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
	const admission = makeSqlAdmission(sql);
	const ledger = makeSqlJobLedger(sql);
	const jobs: JobLedger = {
		...ledger,
		enqueue: (input) => admission.run(ledger.enqueue(input)),
		claimNext: (input) =>
			admission
				.run(ledger.claimNext(input))
				.pipe(Effect.catchTag("AdmissionClosed", () => Effect.succeed(null))),
	};
	const jobWakeups = yield* PubSub.sliding<void>(1);
	const jobCancellations = yield* PubSub.unbounded<ReadonlyArray<JobId>>();
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
	const reconciliationWakeHub = yield* PubSub.sliding<void>(1);
	const reconciliationWakeSubscription = yield* PubSub.subscribe(
		reconciliationWakeHub,
	);
	const durableEventHub =
		yield* PubSub.unbounded<Result.Result<StoredEvent, SessionDomainError>>();
	const publisherLock = yield* Semaphore.make(1);
	let durableSubscriberCount = 0;
	const registerDurableSubscriber = Effect.acquireRelease(
		Effect.sync(() => {
			durableSubscriberCount += 1;
			PubSub.publishUnsafe(reconciliationWakeHub, undefined);
		}),
		() =>
			Effect.sync(() => {
				durableSubscriberCount = Math.max(0, durableSubscriberCount - 1);
			}),
	);
	const decodeDurableNotifications = (
		notifications: Stream.Stream<
			Result.Result<StoredEvent, SessionDomainError>
		>,
	): Stream.Stream<StoredEvent, SessionDomainError> =>
		notifications.pipe(
			Stream.mapEffect((notification) =>
				notification._tag === "Failure"
					? Effect.fail(notification.failure)
					: Effect.succeed(notification.success),
			),
		);
	const readCurrentSequence = sql<{ readonly sequence: number }>`
		SELECT COALESCE(MAX(sequence), 0) AS sequence
		FROM events WHERE stream_kind = 'session'
	`.pipe(Effect.map((rows) => rows[0]?.sequence ?? 0));
	let durableCursor = yield* readCurrentSequence.pipe(Effect.orDie);
	const reconcileDurableEventsUnlocked = Effect.fn(
		"SessionDomain.reconcileDurableEvents",
	)(function* () {
		if (durableSubscriberCount === 0) return;
		const result = yield* dispatchStorage
			.allEventsAfterSequence(durableCursor)
			.pipe(Effect.result);
		if (result._tag === "Failure") {
			if (result.failure._tag === "DispatchPersistenceDecodeError") {
				yield* PubSub.publish(durableEventHub, Result.fail(result.failure));
				yield* Effect.sleep("1 second");
				return;
			}
			yield* Effect.logWarning(
				"Durable session event reconciliation failed; retrying",
			).pipe(Effect.annotateLogs("error", result.failure));
			yield* Effect.sleep("1 second");
			return;
		}
		for (const record of result.success) {
			yield* PubSub.publish(durableEventHub, Result.succeed(record));
			durableCursor = record.sequence;
		}
	});
	const reconcileDurableEvents = () =>
		Semaphore.withPermits(publisherLock, 1, reconcileDurableEventsUnlocked());
	const streamEpochRows = yield* sql<{ readonly value: string }>`
		SELECT value FROM app_state WHERE key = 'session_stream_epoch' LIMIT 1
	`.pipe(Effect.orDie);
	const streamEpoch = streamEpochRows[0]?.value ?? "legacy";
	yield* Stream.merge(
		Stream.fromSubscription(reconciliationWakeSubscription),
		Stream.fromEffectSchedule(Effect.void, Schedule.spaced("100 millis")),
	).pipe(
		Stream.runForEach(reconcileDurableEvents),
		Effect.forkScoped({ startImmediately: true }),
	);

	const events: SessionDomainApi["events"] = ({
		streamId,
		afterSequence = 0,
	}) =>
		Stream.unwrap(
			Effect.gen(function* () {
				yield* registerDurableSubscriber;
				const durableSubscription = yield* PubSub.subscribe(durableEventHub);
				const replay = yield* dispatchStorage.eventsAfterSequence(
					streamId,
					afterSequence,
				);
				let cursor = afterSequence;
				const tail = decodeDurableNotifications(
					Stream.fromSubscription(durableSubscription),
				);
				return Stream.concat(Stream.fromIterable(replay), tail).pipe(
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
				yield* registerDurableSubscriber;
				const durableSubscription = yield* PubSub.subscribe(durableEventHub);
				const replay =
					yield* dispatchStorage.allEventsAfterSequence(afterSequence);
				let cursor = afterSequence;
				const tail = decodeDurableNotifications(
					Stream.fromSubscription(durableSubscription),
				);
				return Stream.concat(Stream.fromIterable(replay), tail).pipe(
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
		streamEpoch: retainedEpoch,
		hasProjection = false,
		historyMode,
		deferToolDetails,
		maxDeltaEvents = 512,
		maxDeltaBytes = MAX_TIMELINE_SNAPSHOT_PROJECTION_BYTES,
	}) =>
		Stream.unwrap(
			Effect.gen(function* () {
				yield* registerDurableSubscriber;
				const durableSubscription = yield* PubSub.subscribe(durableEventHub);

				yield* reconcileDurableEvents();

				const { prefix, throughVersion, historyCursor } =
					yield* sql.withTransaction(
						Effect.gen(function* () {
							const throughVersion =
								yield* dispatchStorage.currentStreamVersion(streamId);
							const retainedVersion = afterVersion ?? 0;
							const epochMismatch =
								retainedEpoch !== undefined && retainedEpoch !== streamEpoch;
							let needsSnapshot =
								!hasProjection ||
								afterVersion === undefined ||
								epochMismatch ||
								retainedVersion > throughVersion ||
								throughVersion - retainedVersion > maxDeltaEvents;
							let captured: readonly StoredEvent[] = [];
							if (!needsSnapshot) {
								captured = yield* dispatchStorage.eventsInVersionRange(
									streamId,
									retainedVersion,
									throughVersion,
								);
								needsSnapshot =
									captured.reduce(
										(total, record) =>
											total +
											new TextEncoder().encode(
												JSON.stringify({
													kind: "event",
													streamEpoch,
													record,
												}),
											).byteLength,
										0,
									) > maxDeltaBytes;
							}
							const prefix: SessionSynchronizationRecord[] = [];
							let historyCursor: number | null = null;
							if (epochMismatch || retainedVersion > throughVersion) {
								prefix.push({
									kind: "reset-required",
									streamEpoch,
									throughVersion,
									reason: epochMismatch ? "restored" : "cursor-invalid",
								});
							}
							if (needsSnapshot) {
								const snapshot = yield* readSessionTimelineSnapshot(
									sql,
									streamId as SessionId,
									deferToolDetails,
								);
								prefix.push({
									kind: "snapshot",
									streamEpoch,
									throughVersion,
									...snapshot,
									...(historyMode === "background" ? { historyMode } : {}),
								});
								historyCursor = snapshot.olderMessageSequence;
							} else {
								prefix.push(
									...captured
										.filter((record) => record.streamVersion > retainedVersion)
										.map((record) => ({
											kind: "event" as const,
											streamEpoch,
											record,
										})),
								);
							}
							return { prefix, throughVersion, historyCursor };
						}),
					);

				const history =
					historyCursor === null || historyMode === "background"
						? Stream.empty
						: Stream.paginate(historyCursor, (pageBeforeSequence) =>
								readSessionTimelineMessagePage(
									sql,
									streamId as SessionId,
									pageBeforeSequence,
								).pipe(
									Effect.flatMap((page) => {
										if (
											page.olderMessageSequence !== null &&
											page.olderMessageSequence >= pageBeforeSequence
										) {
											return Effect.die(
												new Error(
													`Session ${streamId} history cursor did not advance`,
												),
											);
										}
										const record: SessionSynchronizationRecord = {
											kind: "snapshot-chunk",
											streamEpoch,
											throughVersion,
											messages: page.items.map(({ message }) => message),
											olderMessageSequence: page.olderMessageSequence,
										};
										return Effect.succeed([
											[record],
											Option.fromNullOr(page.olderMessageSequence),
										] as const);
									}),
								),
							);
				const synchronized = Stream.succeed<SessionSynchronizationRecord>({
					kind: "synchronized",
					streamEpoch,
					throughVersion,
				});
				let liveVersion = throughVersion;
				const tail = decodeDurableNotifications(
					Stream.fromSubscription(durableSubscription),
				).pipe(
					Stream.filter((record) => record.streamId === streamId),
					Stream.mapEffect((record) => {
						if (record.streamVersion <= liveVersion) {
							return Effect.succeed<StoredEvent | null>(null);
						}
						if (record.streamVersion !== liveVersion + 1) {
							return Effect.fail(
								new DispatchPersistenceDecodeError({
									recordKind: "event",
									recordId: record.eventId,
									reason: `Session stream gap after ${liveVersion}; received ${record.streamVersion}`,
								}),
							);
						}
						liveVersion = record.streamVersion;
						return Effect.succeed<StoredEvent | null>(record);
					}),
					Stream.filter((record): record is StoredEvent => record !== null),
					Stream.map((record) => ({
						kind: "event" as const,
						streamEpoch,
						record,
					})),
				);
				return Stream.concat(
					Stream.fromIterable(prefix),
					Stream.concat(history, Stream.concat(synchronized, tail)),
				);
			}),
		);

	const dispatchTransactionally: SessionDomainApi["dispatchTransactionally"] =
		Effect.fn("SessionDomain.dispatchTransactionally")(
			function* (input, onCommitted) {
				const { result, appended, enqueued, cancelled } = yield* admission.run(
					// Callers can already own a transaction (for example queue admission).
					// Always acquire SQL before the session lock, including those callers.
					Semaphore.withPermits(
						commandLock(input.streamId),
						1,
						Effect.gen(function* () {
							if (
								input.command._tag !== "CreateSession" &&
								input.command._tag !== "DeleteSession" &&
								input.command._tag !== "RequestProviderStop" &&
								input.command._tag !== "PersistMessage"
							) {
								const pending = yield* sql<{
									pending: number;
								}>`SELECT EXISTS(SELECT 1 FROM session_fork_constructions WHERE session_id = ${input.streamId} AND completed_at IS NULL) AS pending`;
								if (pending[0]?.pending === 1)
									return yield* new AdmissionClosed();
							}
							switch (input.command._tag) {
								case "SubmitTurn":
								case "StartTurn":
								case "RetryTurn":
								case "RecoverTurn":
								case "CreateSessionWithInitialTurn":
								case "ReleaseInitialTurn":
								case "ClaimQueuedTurn":
								case "SteerQueuedTurn":
								case "ReserveProviderSession":
								case "SetProvider":
								case "SetModel":
								case "SetWorktree":
								case "UnarchiveSession": {
									const restoring = yield* sql<{
										pending: number;
									}>`SELECT EXISTS(SELECT 1 FROM session_checkpoint_restores WHERE completed_at IS NULL) AS pending`;
									if (restoring[0]?.pending === 1)
										return yield* new AdmissionClosed();
									break;
								}
							}
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
							const cursorRows = yield* sql<{
								readonly last_sequence: number;
							}>`
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

							let cancelled: ReadonlyArray<JobId> = [];
							if (
								input.command._tag === "ExpireAttempt" ||
								appended.some(
									(record) => record.event._tag === "AttemptStarted",
								)
							) {
								cancelled = yield* jobs.cancelUnsettled({
									sessionId: input.streamId,
									kinds: [
										"provider.turn.send",
										"provider.turn.interrupt",
										"provider.turn.recover",
									],
									reason: "Superseded by a new attempt.",
								});
							}
							if (
								appended.some(
									(record) => record.event._tag === "TurnInterruptRequested",
								)
							) {
								cancelled = [
									...cancelled,
									...(yield* jobs.cancelUnsettled({
										sessionId: input.streamId,
										kinds: ["provider.turn.send", "provider.turn.recover"],
										reason: "Turn interrupted by the user.",
									})),
								];
							}

							const enqueued = yield* jobs.enqueue(
								appended.flatMap(jobsForSessionEvent),
							);

							const result = yield* onCommitted(receipt);

							return { result, appended, enqueued, cancelled };
						}),
					),
				);
				if (cancelled.length > 0)
					yield* PubSub.publish(jobCancellations, cancelled);
				// An enclosing transaction may still own SQL. Wake the independent reader
				// rather than wait for a publisher that may itself be waiting for SQL.
				// It observes events only after the enclosing transaction commits.
				if (appended.length > 0)
					yield* PubSub.publish(reconciliationWakeHub, undefined);
				if (enqueued > 0) yield* PubSub.publish(jobWakeups, undefined);
				return result;
			},
		);

	return SessionDomain.of({
		providerReservation: (streamId) =>
			sql<{
				readonly provider_reservation_id: string | null;
			}>`SELECT provider_reservation_id FROM sessions WHERE id = ${streamId} AND archived_at IS NULL LIMIT 1`.pipe(
				Effect.map((rows) => rows[0]?.provider_reservation_id ?? null),
			),
		activeAttempt: (streamId) =>
			sql<{ readonly turn_id: string; readonly attempt_id: string }>`
   SELECT t.id AS turn_id, t.active_attempt_id AS attempt_id FROM session_turns t
   JOIN sessions s ON s.id = t.session_id
   WHERE t.session_id = ${streamId} AND t.status IN ${sql.in([...ACTIVE_SESSION_TURN_STATUSES])}
    AND s.archived_at IS NULL
   ORDER BY t.ordinal DESC LIMIT 1
  `.pipe(
				Effect.map((rows) =>
					rows[0] === undefined
						? null
						: { turnId: rows[0].turn_id, attemptId: rows[0].attempt_id },
				),
			),
		catchUp,
		events,
		allEvents,
		synchronizedEvents,
		currentSequence: readCurrentSequence,
		streamEpoch,
		currentStreamVersion: (streamId) =>
			dispatchStorage.currentStreamVersion(streamId),
		timelineSnapshot: (streamId) => readSessionTimelineSnapshot(sql, streamId),
		timelineMessagePage: (streamId, beforeSequence, limit) =>
			readSessionTimelineMessagePage(sql, streamId, beforeSequence, limit),
		dispatch: (input) => dispatchTransactionally(input, Effect.succeed),
		dispatchTransactionally,
		admission,
		jobs,
		jobWakeups,
		jobCancellations,
	});
});
