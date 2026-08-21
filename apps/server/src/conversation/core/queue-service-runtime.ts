import {
	AgentTurnId,
	ComposerInput,
	type DirectoryUnavailableError,
	MAX_SESSION_QUEUE_INPUT_BYTES,
	MAX_SESSION_QUEUE_ITEMS,
	MAX_SESSION_QUEUE_TOTAL_BYTES,
	MessageId,
	QueuedMessage,
	QueuedMessageCapacityError,
	QueuedMessageNotFoundError,
	QueueState,
	type Session,
	SessionId,
	type SessionNotFoundError,
} from "@zuse/contracts";
import type { SessionCommand } from "@zuse/domain/core/commands";
import type { CommandReceipt } from "@zuse/domain/engine/dispatch";
import { Cause, Effect, Queue, type Scope, Semaphore } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type {
	QueueServiceShape,
	QueueTransactionServiceShape,
} from "../services/conversation-services.ts";
import { handoffToServiceScope } from "./service-scope.ts";

interface QueuedMessageRow {
	readonly id: string;
	readonly session_id: string;
	readonly queue_order: number;
	readonly input_json: string;
	readonly created_at: string;
	readonly updated_at: string;
	readonly ready: number;
}

export interface QueueServiceRuntimeDeps {
	readonly serviceScope: Scope.Scope;
	readonly sql: SqlClient.SqlClient;
	readonly lookupSession: (
		sessionId: SessionId,
	) => Effect.Effect<Session, SessionNotFoundError>;
	readonly submitUserMessage: (
		commandId: string,
		sessionId: SessionId,
		input: ComposerInput,
		clientMessageId: MessageId,
	) => Effect.Effect<boolean, SessionNotFoundError | DirectoryUnavailableError>;
	readonly setQueuePaused: (
		sessionId: SessionId,
		paused: boolean,
		commandId?: string,
	) => Effect.Effect<void>;
	readonly dispatchSessionCommand: (
		sessionId: SessionId,
		command: SessionCommand,
	) => Effect.Effect<void>;
	readonly dispatchSessionCommandWithId: (
		sessionId: SessionId,
		commandId: string,
		command: SessionCommand,
	) => Effect.Effect<CommandReceipt>;
	readonly dispatchSessionCommandWithIdTransactionally: <A, R>(
		sessionId: SessionId,
		commandId: string,
		command: SessionCommand,
		onCommitted: (receipt: CommandReceipt) => Effect.Effect<A, never, R>,
	) => Effect.Effect<A, never, R>;
	readonly runSessionReactors: Effect.Effect<void>;
	readonly resolveActiveTurn: (
		sessionId: SessionId,
	) => Effect.Effect<AgentTurnId | undefined>;
}

export interface QueueServiceRuntime {
	readonly service: QueueServiceShape;
	readonly transactionService: QueueTransactionServiceShape;
	readonly flushAfterIdle: (sessionId: SessionId) => Effect.Effect<void>;
	/** Reconcile durable ready work once startup catch-up has settled session state. */
	readonly reconcileReadyQueues: Effect.Effect<void>;
	readonly pauseAfterInterrupt: (sessionId: SessionId) => Effect.Effect<void>;
	readonly shutdown: (sessionId: SessionId) => Effect.Effect<void>;
}

const queuedMessageFromRow = (row: QueuedMessageRow): QueuedMessage =>
	QueuedMessage.make({
		id: row.id,
		sessionId: SessionId.make(row.session_id),
		input: ComposerInput.make(JSON.parse(row.input_json)),
		position: row.queue_order,
		createdAt: new Date(row.created_at),
		updatedAt: new Date(row.updated_at),
		ready: row.ready !== 0,
	});

const utf8Bytes = (value: string): number =>
	new TextEncoder().encode(value).byteLength;

export const makeQueueServiceRuntime = Effect.fn("QueueServiceRuntime.make")(
	function* (deps: QueueServiceRuntimeDeps) {
		const {
			serviceScope,
			sql,
			lookupSession,
			submitUserMessage,
			setQueuePaused,
			dispatchSessionCommand,
			dispatchSessionCommandWithId,
			dispatchSessionCommandWithIdTransactionally,
			runSessionReactors,
			resolveActiveTurn,
		} = deps;
		const flushLocks = new Map<SessionId, Semaphore.Semaphore>();
		const capacityLocks = new Map<SessionId, Semaphore.Semaphore>();
		const drainRequests = yield* Queue.unbounded<SessionId>();
		const retryAttempts = new Map<SessionId, number>();
		const scheduledRetries = new Set<SessionId>();
		const flushLock = (sessionId: SessionId): Semaphore.Semaphore => {
			const existing = flushLocks.get(sessionId);
			if (existing !== undefined) return existing;
			const created = Semaphore.makeUnsafe(1);
			flushLocks.set(sessionId, created);
			return created;
		};
		const capacityLock = (sessionId: SessionId): Semaphore.Semaphore => {
			const existing = capacityLocks.get(sessionId);
			if (existing !== undefined) return existing;
			const created = Semaphore.makeUnsafe(1);
			capacityLocks.set(sessionId, created);
			return created;
		};
		let requestFlush: (sessionId: SessionId) => Effect.Effect<void> = () =>
			Effect.void;

		const listRows = (sessionId: SessionId) =>
			sql<QueuedMessageRow>`
      SELECT id, session_id, queue_order, input_json, created_at, updated_at, ready
      FROM queued_messages
      WHERE session_id = ${sessionId}
      ORDER BY queue_order ASC, created_at ASC
    `.pipe(
				Effect.map((rows) => rows.map(queuedMessageFromRow)),
				Effect.orDie,
			);

		const isPaused = (sessionId: SessionId) =>
			sql<{ readonly queue_paused: number }>`
      SELECT queue_paused FROM sessions WHERE id = ${sessionId} LIMIT 1
    `.pipe(
				Effect.map((rows) => (rows[0]?.queue_paused ?? 0) !== 0),
				Effect.orDie,
			);

		const state = (sessionId: SessionId): Effect.Effect<QueueState> =>
			Effect.all([listRows(sessionId), isPaused(sessionId)]).pipe(
				Effect.map(([items, paused]) => QueueState.make({ items, paused })),
			);

		const assertQueueCapacity = Effect.fn("QueueService.assertCapacity")(
			function* (
				sessionId: SessionId,
				items: ReadonlyArray<QueuedMessage>,
				candidate: QueuedMessage,
			) {
				const inputJson = JSON.stringify(candidate.input);
				const inputBytes = utf8Bytes(inputJson);
				if (inputBytes > MAX_SESSION_QUEUE_INPUT_BYTES) {
					return yield* new QueuedMessageCapacityError({
						sessionId,
						reason: "item-too-large",
						limit: MAX_SESSION_QUEUE_INPUT_BYTES,
						actual: inputBytes,
					});
				}
				const retained = items.filter((item) => item.id !== candidate.id);
				const itemCount = retained.length + 1;
				if (itemCount > MAX_SESSION_QUEUE_ITEMS) {
					return yield* new QueuedMessageCapacityError({
						sessionId,
						reason: "too-many-items",
						limit: MAX_SESSION_QUEUE_ITEMS,
						actual: itemCount,
					});
				}
				const totalBytes = utf8Bytes(
					JSON.stringify(
						QueueState.make({
							items: [...retained, candidate],
							paused: false,
						}),
					),
				);
				if (totalBytes > MAX_SESSION_QUEUE_TOTAL_BYTES) {
					return yield* new QueuedMessageCapacityError({
						sessionId,
						reason: "queue-too-large",
						limit: MAX_SESSION_QUEUE_TOTAL_BYTES,
						actual: totalBytes,
					});
				}
			},
		);

		const setPaused = (
			sessionId: SessionId,
			paused: boolean,
			commandId?: string,
		) =>
			Effect.gen(function* () {
				yield* setQueuePaused(sessionId, paused, commandId);
			});

		const normalizePositions = (sessionId: SessionId) =>
			Effect.gen(function* () {
				const rows = yield* sql<{ readonly id: string }>`
        SELECT id FROM queued_messages
        WHERE session_id = ${sessionId}
        ORDER BY queue_order ASC, created_at ASC
      `.pipe(Effect.orDie);
				yield* dispatchSessionCommand(sessionId, {
					_tag: "ReorderQueuedTurns",
					queueIds: rows.map((row) => row.id),
					reorderedAt: Date.now(),
				});
			});

		const clearPauseIfEmpty = (sessionId: SessionId, commandId?: string) =>
			Effect.gen(function* () {
				if (
					(yield* listRows(sessionId)).length > 0 ||
					!(yield* isPaused(sessionId))
				) {
					return;
				}
				yield* setPaused(
					sessionId,
					false,
					commandId === undefined ? undefined : `${commandId}:unpause`,
				);
			});

		const addQueuedMessage: QueueServiceShape["addQueuedMessage"] = (
			commandId,
			sessionId,
			input,
			queueId,
			ready = true,
			flush = true,
		) =>
			capacityLock(sessionId).withPermits(1)(
				Effect.gen(function* () {
					yield* lookupSession(sessionId);
					const existingItems = yield* listRows(sessionId);
					if (queueId !== undefined) {
						const existing = existingItems.find((item) => item.id === queueId);
						if (existing !== undefined) {
							const item = existing;
							if (item.ready && flush) {
								yield* requestFlush(sessionId);
							}
							return item;
						}
					}
					const position =
						Math.max(-1, ...existingItems.map((item) => item.position)) + 1;
					const now = new Date();
					const id = queueId ?? `q_${crypto.randomUUID()}`;
					const inputJson = JSON.stringify(input);
					yield* assertQueueCapacity(
						sessionId,
						existingItems,
						QueuedMessage.make({
							id,
							sessionId,
							input,
							position,
							createdAt: now,
							updatedAt: now,
							ready,
						}),
					);
					const item = yield* dispatchSessionCommandWithIdTransactionally(
						sessionId,
						commandId,
						{
							_tag: "EnqueueTurn",
							queueId: id,
							inputJson,
							position,
							createdAt: now.getTime(),
							ready,
						},
						(receipt) =>
							sql<QueuedMessageRow>`
                SELECT id, session_id, queue_order, input_json, created_at, updated_at, ready
                FROM queued_messages
                WHERE id = ${id}
                LIMIT 1
              `.pipe(
								Effect.flatMap((rows) => {
									const row = rows[0];
									if (row !== undefined && row.session_id !== sessionId) {
										return Effect.die(
											new Error(`queue id ${id} belongs to another session`),
										);
									}
									if (row === undefined && receipt.eventIds.length > 0) {
										return Effect.die(
											new Error(`queue id ${id} was not projected`),
										);
									}
									// An idempotent replay can arrive after the ready item was
									// already claimed. The original command still succeeded, so
									// return its convergent representation instead of a false error.
									return Effect.succeed(
										row === undefined
											? QueuedMessage.make({
													id,
													sessionId,
													input,
													position,
													createdAt: now,
													updatedAt: now,
													ready,
												})
											: queuedMessageFromRow(row),
									);
								}),
								Effect.orDie,
							),
					);
					if (item.ready && flush) {
						yield* requestFlush(sessionId);
					}
					return item;
				}),
			);

		const addQueuedMessageTransactionally: QueueTransactionServiceShape["addQueuedMessageTransactionally"] =
			(commandId, sessionId, input, queueId, ready, onCommitted) =>
				capacityLock(sessionId).withPermits(1)(
					Effect.gen(function* () {
						yield* lookupSession(sessionId);
						const existingItems = yield* listRows(sessionId);
						const existing = existingItems.find((item) => item.id === queueId);
						if (existing !== undefined) {
							yield* onCommitted(existing);
							return;
						}
						const position =
							Math.max(-1, ...existingItems.map((item) => item.position)) + 1;
						const now = new Date();
						const candidate = QueuedMessage.make({
							id: queueId,
							sessionId,
							input,
							position,
							createdAt: now,
							updatedAt: now,
							ready,
						});
						yield* assertQueueCapacity(sessionId, existingItems, candidate);
						yield* Effect.uninterruptible(
							dispatchSessionCommandWithIdTransactionally(
								sessionId,
								commandId,
								{
									_tag: "EnqueueTurn",
									queueId,
									inputJson: JSON.stringify(input),
									position,
									createdAt: now.getTime(),
									ready,
								},
								() => onCommitted(candidate),
							).pipe(
								Effect.andThen(ready ? requestFlush(sessionId) : Effect.void),
							),
						);
					}),
				);

		const listQueuedMessages: QueueServiceShape["listQueuedMessages"] = (
			sessionId,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				return yield* state(sessionId);
			});

		const updateQueuedMessage: QueueServiceShape["updateQueuedMessage"] = (
			commandId,
			sessionId,
			queueId,
			input,
		) =>
			capacityLock(sessionId).withPermits(1)(
				Effect.gen(function* () {
					yield* lookupSession(sessionId);
					const existingItems = yield* listRows(sessionId);
					const existing = existingItems.find((item) => item.id === queueId);
					if (existing === undefined) {
						return yield* new QueuedMessageNotFoundError({
							sessionId,
							queueId,
						});
					}
					const updatedAt = new Date();
					const inputJson = JSON.stringify(input);
					yield* assertQueueCapacity(
						sessionId,
						existingItems,
						QueuedMessage.make({
							...existing,
							input,
							updatedAt,
							ready: true,
						}),
					);
					yield* dispatchSessionCommandWithId(sessionId, commandId, {
						_tag: "UpdateQueuedTurn",
						queueId,
						inputJson,
						updatedAt: updatedAt.getTime(),
						ready: true,
					});
					const rows = yield* sql<QueuedMessageRow>`
        SELECT id, session_id, queue_order, input_json, created_at, updated_at, ready
        FROM queued_messages
        WHERE session_id = ${sessionId} AND id = ${queueId}
        LIMIT 1
      `.pipe(Effect.orDie);
					const row = rows[0];
					if (row === undefined) {
						return yield* new QueuedMessageNotFoundError({
							sessionId,
							queueId,
						});
					}
					const item = queuedMessageFromRow(row);
					yield* requestFlush(sessionId);
					return item;
				}),
			);

		const deleteQueuedMessage: QueueServiceShape["deleteQueuedMessage"] = (
			commandId,
			sessionId,
			queueId,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				yield* dispatchSessionCommandWithId(sessionId, commandId, {
					_tag: "RemoveQueuedTurn",
					queueId,
					removedAt: Date.now(),
				});
				yield* normalizePositions(sessionId);
				yield* clearPauseIfEmpty(sessionId, commandId);
			});

		const reorderQueuedMessages: QueueServiceShape["reorderQueuedMessages"] = (
			commandId,
			sessionId,
			queueIds,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				const existing = yield* listRows(sessionId);
				const byId = new Map(existing.map((item) => [item.id, item]));
				const ordered = [
					...queueIds.flatMap((id) => {
						const item = byId.get(id);
						if (item === undefined) return [];
						byId.delete(id);
						return [item];
					}),
					...existing.filter((item) => byId.has(item.id)),
				];
				yield* dispatchSessionCommandWithId(sessionId, commandId, {
					_tag: "ReorderQueuedTurns",
					queueIds: ordered.map((item) => item.id),
					reorderedAt: Date.now(),
				});
				const next = yield* listRows(sessionId);
				return next;
			});

		const claim = (sessionId: SessionId, queueId: string) =>
			Effect.gen(function* () {
				const rows = yield* sql<QueuedMessageRow>`
		SELECT id, session_id, queue_order, input_json, created_at, updated_at, ready
		FROM queued_messages
		WHERE session_id = ${sessionId} AND id = ${queueId} AND ready = 1
		LIMIT 1
      `.pipe(Effect.orDie);
				const row = rows[0];
				if (row === undefined) return null;
				const item = queuedMessageFromRow(row);
				yield* dispatchSessionCommand(sessionId, {
					_tag: "ClaimQueuedTurn",
					queueId,
					claimedAt: Date.now(),
				});
				yield* normalizePositions(sessionId);
				return item;
			});

		const restore = (item: QueuedMessage) =>
			Effect.gen(function* () {
				yield* dispatchSessionCommand(item.sessionId, {
					_tag: "EnqueueTurn",
					queueId: item.id,
					inputJson: JSON.stringify(item.input),
					position: item.position,
					createdAt: item.createdAt.getTime(),
					ready: true,
				});
				yield* normalizePositions(item.sessionId);
			});

		const sendClaimed = (item: QueuedMessage) =>
			submitUserMessage(
				`queue-submit:${item.id}`,
				item.sessionId,
				item.input,
				MessageId.make(`queued_${item.id}`),
			).pipe(
				Effect.flatMap((accepted) => (accepted ? Effect.void : restore(item))),
				Effect.catchTag("DirectoryUnavailableError", () =>
					restore(item).pipe(Effect.andThen(setPaused(item.sessionId, true))),
				),
				Effect.catchCause((cause) =>
					restore(item).pipe(Effect.andThen(Effect.failCause(cause))),
				),
			);

		const runQueuedMessageWhileIdle = (
			sessionId: SessionId,
			queueId: string,
			commandId: string,
		): Effect.Effect<void, SessionNotFoundError> =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				yield* setPaused(sessionId, false, `${commandId}:unpause`);
				const item = yield* claim(sessionId, queueId);
				if (item !== null) yield* sendClaimed(item);
			});

		const runQueuedMessageNext: QueueServiceShape["runQueuedMessageNext"] = (
			commandId,
			sessionId,
			queueId,
		) =>
			flushLock(sessionId).withPermits(1)(
				Effect.gen(function* () {
					yield* lookupSession(sessionId);
					const resolvedTurnId = yield* resolveActiveTurn(sessionId);
					if (resolvedTurnId === undefined) {
						yield* runQueuedMessageWhileIdle(sessionId, queueId, commandId);
						return;
					}
					yield* handoffToServiceScope(
						dispatchSessionCommandWithId(sessionId, commandId, {
							_tag: "SteerQueuedTurn",
							expectedTurnId: resolvedTurnId,
							queueId,
							successorTurnId: AgentTurnId.make(`turn_queued_${queueId}`),
							requestedAt: Date.now(),
						}),
						runSessionReactors,
						serviceScope,
					);
				}),
			);

		const flushHead = (sessionId: SessionId) =>
			Effect.gen(function* () {
				const session = yield* lookupSession(sessionId);
				if (session.status === "error") return;
				if (yield* isPaused(sessionId)) return;
				const head = (yield* listRows(sessionId))[0];
				if (head === undefined || !head.ready) return;
				const item = yield* claim(sessionId, head.id);
				if (item !== null) yield* sendClaimed(item);
			});

		const flushQueuedMessages: QueueServiceShape["flushQueuedMessages"] = (
			_commandId,
			sessionId,
		) =>
			flushLock(sessionId).withPermits(1)(
				Effect.gen(function* () {
					// Explicit flush preserves recovery of an atomically restored item.
					const session = yield* lookupSession(sessionId);
					if (session.status === "running" || session.status === "booting")
						return;
					yield* flushHead(sessionId);
				}),
			);

		const flushAfterIdle = (sessionId: SessionId) =>
			flushLock(sessionId).withPermits(1)(
				Effect.gen(function* () {
					yield* lookupSession(sessionId);
					// Automatic flushes use turn events as their authority. The session
					// status projection can lag settlement in either direction.
					if ((yield* resolveActiveTurn(sessionId)) !== undefined) return;
					yield* flushHead(sessionId);
				}),
			);

		const resumeQueuedMessages: QueueServiceShape["resumeQueuedMessages"] = (
			commandId,
			sessionId,
		) =>
			Effect.gen(function* () {
				const session = yield* lookupSession(sessionId);
				if (session.status === "error") {
					yield* dispatchSessionCommand(sessionId, {
						_tag: "SetStatus",
						status: "idle",
						updatedAt: Date.now(),
					});
				}
				yield* setPaused(sessionId, false, `${commandId}:unpause`);
				yield* flushQueuedMessages(`${commandId}:flush`, sessionId);
			});

		requestFlush = (sessionId) =>
			Queue.offer(drainRequests, sessionId).pipe(Effect.asVoid);
		const scheduleRetry = (sessionId: SessionId) =>
			Effect.gen(function* () {
				if (scheduledRetries.has(sessionId)) return;
				const attempt = (retryAttempts.get(sessionId) ?? 0) + 1;
				retryAttempts.set(sessionId, attempt);
				scheduledRetries.add(sessionId);
				const delayMs = Math.min(100 * 2 ** (attempt - 1), 10_000);
				const retry = Effect.sleep(`${delayMs} millis`).pipe(
					Effect.andThen(
						Effect.sync(() => {
							scheduledRetries.delete(sessionId);
						}),
					),
					Effect.andThen(requestFlush(sessionId)),
				);
				yield* Effect.forkIn(retry, serviceScope);
			});
		const runAutomaticDrain = (sessionId: SessionId) =>
			flushAfterIdle(sessionId).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						retryAttempts.delete(sessionId);
					}),
				),
				Effect.catchTag("SessionNotFoundError", () =>
					Effect.sync(() => {
						retryAttempts.delete(sessionId);
						scheduledRetries.delete(sessionId);
					}),
				),
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.failCause(cause)
						: Effect.logError(
								`[ConversationQueue] drain failed for ${sessionId}: ${String(cause)}`,
							).pipe(Effect.andThen(scheduleRetry(sessionId))),
				),
			);
		const drainWorker = Effect.forever(
			Queue.take(drainRequests).pipe(Effect.flatMap(runAutomaticDrain)),
		);
		for (let index = 0; index < 4; index += 1) {
			yield* Effect.forkIn(drainWorker, serviceScope);
		}

		const pauseAfterInterrupt = (sessionId: SessionId) =>
			Effect.gen(function* () {
				if ((yield* listRows(sessionId)).length > 0) {
					yield* setPaused(sessionId, true);
				}
			});

		const shutdown = (_sessionId: SessionId) => Effect.void;
		const reconcileReadyQueues = Effect.gen(function* () {
			const sessions = yield* sql<{ readonly session_id: string }>`
				SELECT DISTINCT q.session_id
				FROM queued_messages q
				INNER JOIN sessions s ON s.id = q.session_id
				WHERE q.ready = 1
					AND s.queue_paused = 0
					AND s.archived_at IS NULL
					AND s.status <> 'error'
				ORDER BY q.session_id
			`.pipe(Effect.orDie);
			yield* Effect.forEach(
				sessions,
				(row) => runAutomaticDrain(SessionId.make(row.session_id)),
				{ discard: true },
			);
		});

		// One-time-compatible import: legacy rows become aggregate events before
		// runtime mutations begin. The decider makes this restart-idempotent and
		// the SQL table remains only the read projection.
		const legacyRows = yield* sql<QueuedMessageRow>`
			SELECT id, session_id, queue_order, input_json, created_at, updated_at, ready
			FROM queued_messages
			ORDER BY session_id, queue_order, created_at
		`.pipe(Effect.orDie);
		for (const row of legacyRows) {
			const sessionId = SessionId.make(row.session_id);
			yield* dispatchSessionCommandWithId(
				sessionId,
				`queue:import:${sessionId}:${row.id}`,
				{
					_tag: "EnqueueTurn",
					queueId: row.id,
					inputJson: row.input_json,
					position: row.queue_order,
					createdAt: new Date(row.created_at).getTime(),
					ready: row.ready !== 0,
				},
			);
		}

		const service = {
			listQueuedMessages,
			addQueuedMessage,
			updateQueuedMessage,
			deleteQueuedMessage,
			runQueuedMessageNext,
			reorderQueuedMessages,
			flushQueuedMessages,
			resumeQueuedMessages,
		} satisfies QueueServiceShape;

		return {
			service,
			transactionService: { addQueuedMessageTransactionally },
			flushAfterIdle: requestFlush,
			reconcileReadyQueues,
			pauseAfterInterrupt,
			shutdown,
		} satisfies QueueServiceRuntime;
	},
);
