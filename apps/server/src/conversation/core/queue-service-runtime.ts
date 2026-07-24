import {
	ComposerInput,
	type DirectoryUnavailableError,
	MessageId,
	QueuedMessage,
	QueuedMessageNotFoundError,
	QueueState,
	type Session,
	SessionId,
	type SessionNotFoundError,
} from "@zuse/contracts";
import type { SessionCommand } from "@zuse/domain/core/commands";
import { Effect, type Scope, Semaphore } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { QueueServiceShape } from "../services/conversation-services.ts";

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
		sessionId: SessionId,
		input: ComposerInput,
		clientMessageId: MessageId,
	) => Effect.Effect<boolean, SessionNotFoundError | DirectoryUnavailableError>;
	readonly setQueuePaused: (
		sessionId: SessionId,
		paused: boolean,
	) => Effect.Effect<void>;
	readonly dispatchSessionCommand: (
		sessionId: SessionId,
		command: SessionCommand,
	) => Effect.Effect<void>;
	readonly dispatchSessionCommandWithId: (
		sessionId: SessionId,
		commandId: string,
		command: SessionCommand,
	) => Effect.Effect<void>;
	readonly runSessionReactors: Effect.Effect<void>;
}

export interface QueueServiceRuntime {
	readonly service: QueueServiceShape;
	readonly flushAfterIdle: (sessionId: SessionId) => Effect.Effect<void>;
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
			runSessionReactors,
		} = deps;
		const flushLocks = new Map<SessionId, Semaphore.Semaphore>();
		const flushLock = (sessionId: SessionId): Semaphore.Semaphore => {
			const existing = flushLocks.get(sessionId);
			if (existing !== undefined) return existing;
			const created = Semaphore.makeUnsafe(1);
			flushLocks.set(sessionId, created);
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

		const setPaused = (sessionId: SessionId, paused: boolean) =>
			Effect.gen(function* () {
				yield* setQueuePaused(sessionId, paused);
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

		const clearPauseIfEmpty = (sessionId: SessionId) =>
			Effect.gen(function* () {
				if (
					(yield* listRows(sessionId)).length > 0 ||
					!(yield* isPaused(sessionId))
				) {
					return;
				}
				yield* setPaused(sessionId, false);
			});

		const addQueuedMessage: QueueServiceShape["addQueuedMessage"] = (
			sessionId,
			input,
			queueId,
			ready = true,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				if (queueId !== undefined) {
					const existing = yield* sql<QueuedMessageRow>`
        SELECT id, session_id, queue_order, input_json, created_at, updated_at, ready
        FROM queued_messages
        WHERE session_id = ${sessionId} AND id = ${queueId}
        LIMIT 1
      `.pipe(Effect.orDie);
					if (existing[0] !== undefined) {
						const item = queuedMessageFromRow(existing[0]);
						if (item.ready) {
							yield* Effect.forkIn(requestFlush(sessionId), serviceScope);
						}
						return item;
					}
				}
				const maxRows = yield* sql<{ readonly max_position: number | null }>`
        SELECT MAX(queue_order) AS max_position
        FROM queued_messages WHERE session_id = ${sessionId}
      `.pipe(Effect.orDie);
				const position = (maxRows[0]?.max_position ?? -1) + 1;
				const now = new Date();
				const id = queueId ?? `q_${crypto.randomUUID()}`;
				yield* dispatchSessionCommand(sessionId, {
					_tag: "EnqueueTurn",
					queueId: id,
					inputJson: JSON.stringify(input),
					position,
					createdAt: now.getTime(),
					ready,
				});
				const persisted = yield* sql<QueuedMessageRow>`
        SELECT id, session_id, queue_order, input_json, created_at, updated_at, ready
        FROM queued_messages
        WHERE session_id = ${sessionId} AND id = ${id}
        LIMIT 1
      `.pipe(Effect.orDie);
				const row = persisted[0];
				if (row === undefined) {
					return yield* Effect.die(
						new Error(`queue id ${id} belongs to another session`),
					);
				}
				const item = queuedMessageFromRow(row);
				if (item.ready) {
					yield* Effect.forkIn(requestFlush(sessionId), serviceScope);
				}
				return item;
			});

		const listQueuedMessages: QueueServiceShape["listQueuedMessages"] = (
			sessionId,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				return yield* state(sessionId);
			});

		const updateQueuedMessage: QueueServiceShape["updateQueuedMessage"] = (
			sessionId,
			queueId,
			input,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				const existing = yield* sql<{ readonly id: string }>`
					SELECT id FROM queued_messages
					WHERE session_id = ${sessionId} AND id = ${queueId}
					LIMIT 1
				`.pipe(Effect.orDie);
				if (existing[0] === undefined) {
					return yield* new QueuedMessageNotFoundError({ sessionId, queueId });
				}
				yield* dispatchSessionCommand(sessionId, {
					_tag: "UpdateQueuedTurn",
					queueId,
					inputJson: JSON.stringify(input),
					updatedAt: Date.now(),
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
					return yield* new QueuedMessageNotFoundError({ sessionId, queueId });
				}
				const item = queuedMessageFromRow(row);
				yield* Effect.forkIn(requestFlush(sessionId), serviceScope);
				return item;
			});

		const deleteQueuedMessage: QueueServiceShape["deleteQueuedMessage"] = (
			sessionId,
			queueId,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				yield* dispatchSessionCommand(sessionId, {
					_tag: "RemoveQueuedTurn",
					queueId,
					removedAt: Date.now(),
				});
				yield* normalizePositions(sessionId);
				yield* clearPauseIfEmpty(sessionId);
			});

		const reorderQueuedMessages: QueueServiceShape["reorderQueuedMessages"] = (
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
				yield* dispatchSessionCommand(sessionId, {
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

		const sendQueuedMessageNow: QueueServiceShape["sendQueuedMessageNow"] = (
			sessionId,
			queueId,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				yield* setPaused(sessionId, false);
				const item = yield* claim(sessionId, queueId);
				if (item !== null) yield* sendClaimed(item);
			});

		const steerQueuedTurn: QueueServiceShape["steerQueuedTurn"] = (
			sessionId,
			expectedTurnId,
			queueId,
			successorTurnId,
			commandId,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				yield* dispatchSessionCommandWithId(sessionId, commandId, {
					_tag: "SteerQueuedTurn",
					expectedTurnId,
					queueId,
					successorTurnId,
					requestedAt: Date.now(),
				});
				yield* runSessionReactors;
			});

		const flushQueuedMessages: QueueServiceShape["flushQueuedMessages"] = (
			sessionId,
		) =>
			flushLock(sessionId).withPermits(1)(
				Effect.gen(function* () {
					yield* lookupSession(sessionId);
					const session = yield* lookupSession(sessionId);
					if (session.status === "running" || session.status === "booting")
						return;
					if (yield* isPaused(sessionId)) return;
					const head = (yield* listRows(sessionId))[0];
					if (head === undefined || !head.ready) return;
					const item = yield* claim(sessionId, head.id);
					if (item !== null) yield* sendClaimed(item);
				}),
			);

		const resumeQueuedMessages: QueueServiceShape["resumeQueuedMessages"] = (
			sessionId,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				yield* setPaused(sessionId, false);
				yield* flushQueuedMessages(sessionId);
			});

		requestFlush = (sessionId) =>
			lookupSession(sessionId).pipe(
				Effect.flatMap((session) =>
					session.status === "idle"
						? flushQueuedMessages(sessionId)
						: Effect.void,
				),
				Effect.catch(() => Effect.void),
			);

		const pauseAfterInterrupt = (sessionId: SessionId) =>
			Effect.gen(function* () {
				if ((yield* listRows(sessionId)).length > 0) {
					yield* setPaused(sessionId, true);
				}
			});

		const shutdown = (_sessionId: SessionId) => Effect.void;

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
			sendQueuedMessageNow,
			reorderQueuedMessages,
			flushQueuedMessages,
			resumeQueuedMessages,
			steerQueuedTurn,
		} satisfies QueueServiceShape;

		return {
			service,
			flushAfterIdle: (sessionId) =>
				flushQueuedMessages(sessionId).pipe(Effect.catch(() => Effect.void)),
			pauseAfterInterrupt,
			shutdown,
		} satisfies QueueServiceRuntime;
	},
);
