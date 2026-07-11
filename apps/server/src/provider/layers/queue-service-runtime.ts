import {
  ComposerInput,
  QueuedMessage,
  QueueState,
  type Session,
  SessionId,
  type SessionNotFoundError,
} from "@zuse/contracts";
import { Effect, PubSub, Ref, Stream } from "effect";
import type { SqlClient } from "effect/unstable/sql";

import type { QueueServiceShape } from "../services/conversation-services.ts";

interface QueuedMessageRow {
  readonly id: string;
  readonly session_id: string;
  readonly queue_order: number;
  readonly input_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface QueueServiceRuntimeDeps {
  readonly sql: SqlClient.SqlClient;
  readonly lookupSession: (
    sessionId: SessionId,
  ) => Effect.Effect<Session, SessionNotFoundError>;
  readonly submitUserMessage: (
    sessionId: SessionId,
    input: ComposerInput,
  ) => Effect.Effect<boolean, SessionNotFoundError>;
  readonly settleActiveTurn: (
    sessionId: SessionId,
    outcome: "error",
  ) => Effect.Effect<void>;
  readonly setQueuePaused: (
    sessionId: SessionId,
    paused: boolean,
  ) => Effect.Effect<void>;
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
  });

export const makeQueueServiceRuntime = Effect.fn("QueueServiceRuntime.make")(
  function* (deps: QueueServiceRuntimeDeps) {
    const {
      sql,
      lookupSession,
      submitUserMessage,
      settleActiveTurn,
      setQueuePaused,
    } = deps;
    const pubsubs = yield* Ref.make<
      ReadonlyMap<SessionId, PubSub.PubSub<QueueState>>
    >(new Map());
    const flushing = yield* Ref.make<ReadonlySet<SessionId>>(new Set());

    const getOrMakePubsub = (sessionId: SessionId) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(pubsubs);
        const existing = current.get(sessionId);
        if (existing !== undefined) return existing;
        const pubsub = yield* PubSub.unbounded<QueueState>();
        yield* Ref.update(pubsubs, (entries) => {
          const next = new Map(entries);
          next.set(sessionId, pubsub);
          return next;
        });
        return pubsub;
      });

    const listRows = (sessionId: SessionId) =>
      sql<QueuedMessageRow>`
      SELECT id, session_id, queue_order, input_json, created_at, updated_at
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

    const broadcast = (sessionId: SessionId) =>
      Effect.gen(function* () {
        const snapshot = yield* state(sessionId);
        const pubsub = yield* getOrMakePubsub(sessionId);
        yield* PubSub.publish(pubsub, snapshot);
      });

    const setPaused = (sessionId: SessionId, paused: boolean) =>
      Effect.gen(function* () {
        yield* setQueuePaused(sessionId, paused);
        yield* broadcast(sessionId);
      });

    const normalizePositions = (sessionId: SessionId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly id: string }>`
        SELECT id FROM queued_messages
        WHERE session_id = ${sessionId}
        ORDER BY queue_order ASC, created_at ASC
      `.pipe(Effect.orDie);
        for (const [position, row] of rows.entries()) {
          yield* sql`
          UPDATE queued_messages SET queue_order = ${position}
          WHERE id = ${row.id} AND session_id = ${sessionId}
        `.pipe(Effect.orDie);
        }
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
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        const maxRows = yield* sql<{ readonly max_position: number | null }>`
        SELECT MAX(queue_order) AS max_position
        FROM queued_messages WHERE session_id = ${sessionId}
      `.pipe(Effect.orDie);
        const position = (maxRows[0]?.max_position ?? -1) + 1;
        const now = new Date();
        const id = `q_${crypto.randomUUID()}`;
        yield* sql`
        INSERT INTO queued_messages
          (id, session_id, queue_order, input_json, created_at, updated_at)
        VALUES
          (${id}, ${sessionId}, ${position}, ${JSON.stringify(input)},
           ${now.toISOString()}, ${now.toISOString()})
      `.pipe(Effect.orDie);
        const item = QueuedMessage.make({
          id,
          sessionId,
          input,
          position,
          createdAt: now,
          updatedAt: now,
        });
        yield* broadcast(sessionId);
        return item;
      });

    const listQueuedMessages: QueueServiceShape["listQueuedMessages"] = (
      sessionId,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        return yield* state(sessionId);
      });

    const streamQueuedMessages: QueueServiceShape["streamQueuedMessages"] = (
      sessionId,
    ) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* lookupSession(sessionId);
          const pubsub = yield* getOrMakePubsub(sessionId);
          const subscription = yield* PubSub.subscribe(pubsub);
          return Stream.concat(
            Stream.fromEffect(state(sessionId)),
            Stream.fromSubscription(subscription),
          );
        }),
      );

    const updateQueuedMessage: QueueServiceShape["updateQueuedMessage"] = (
      sessionId,
      queueId,
      input,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        yield* sql`
        UPDATE queued_messages
        SET input_json = ${JSON.stringify(input)}, updated_at = ${new Date().toISOString()}
        WHERE session_id = ${sessionId} AND id = ${queueId}
      `.pipe(Effect.orDie);
        const rows = yield* sql<QueuedMessageRow>`
        SELECT id, session_id, queue_order, input_json, created_at, updated_at
        FROM queued_messages
        WHERE session_id = ${sessionId} AND id = ${queueId}
        LIMIT 1
      `.pipe(Effect.orDie);
        const item =
          rows[0] === undefined
            ? yield* addQueuedMessage(sessionId, input)
            : queuedMessageFromRow(rows[0]);
        yield* broadcast(sessionId);
        return item;
      });

    const deleteQueuedMessage: QueueServiceShape["deleteQueuedMessage"] = (
      sessionId,
      queueId,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        yield* sql`
        DELETE FROM queued_messages
        WHERE session_id = ${sessionId} AND id = ${queueId}
      `.pipe(Effect.orDie);
        yield* normalizePositions(sessionId);
        yield* clearPauseIfEmpty(sessionId);
        yield* broadcast(sessionId);
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
        const updatedAt = new Date().toISOString();
        for (const [position, item] of ordered.entries()) {
          yield* sql`
          UPDATE queued_messages
          SET queue_order = ${position}, updated_at = ${updatedAt}
          WHERE session_id = ${sessionId} AND id = ${item.id}
        `.pipe(Effect.orDie);
        }
        const next = yield* listRows(sessionId);
        yield* broadcast(sessionId);
        return next;
      });

    const claim = (sessionId: SessionId, queueId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<QueuedMessageRow>`
        SELECT id, session_id, queue_order, input_json, created_at, updated_at
        FROM queued_messages
        WHERE session_id = ${sessionId} AND id = ${queueId}
        LIMIT 1
      `.pipe(Effect.orDie);
        const row = rows[0];
        if (row === undefined) return null;
        const item = queuedMessageFromRow(row);
        yield* sql`
        DELETE FROM queued_messages
        WHERE session_id = ${sessionId} AND id = ${queueId}
      `.pipe(Effect.orDie);
        yield* normalizePositions(sessionId);
        yield* broadcast(sessionId);
        return item;
      });

    const restore = (item: QueuedMessage) =>
      Effect.gen(function* () {
        const existing = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM queued_messages
        WHERE session_id = ${item.sessionId} AND id = ${item.id}
      `.pipe(Effect.orDie);
        if ((existing[0]?.count ?? 0) > 0) return;
        yield* sql`
        INSERT INTO queued_messages
          (id, session_id, queue_order, input_json, created_at, updated_at)
        VALUES
          (${item.id}, ${item.sessionId}, ${item.position},
           ${JSON.stringify(item.input)}, ${item.createdAt.toISOString()},
           ${new Date().toISOString()})
      `.pipe(Effect.orDie);
        yield* normalizePositions(item.sessionId);
        yield* broadcast(item.sessionId);
      });

    const sendClaimed = (item: QueuedMessage) =>
      Effect.gen(function* () {
        if (yield* submitUserMessage(item.sessionId, item.input)) return;
        yield* settleActiveTurn(item.sessionId, "error");
        yield* restore(item);
      });

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

    const flushQueuedMessages: QueueServiceShape["flushQueuedMessages"] = (
      sessionId,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        const active = yield* Ref.get(flushing);
        if (active.has(sessionId)) return;
        yield* Ref.update(flushing, (entries) =>
          new Set(entries).add(sessionId),
        );
        try {
          const session = yield* lookupSession(sessionId);
          if (session.status === "running" || session.status === "booting") {
            return;
          }
          if (yield* isPaused(sessionId)) return;
          const head = (yield* listRows(sessionId))[0];
          if (head === undefined) return;
          const item = yield* claim(sessionId, head.id);
          if (item !== null) yield* sendClaimed(item);
        } finally {
          yield* Ref.update(flushing, (entries) => {
            const next = new Set(entries);
            next.delete(sessionId);
            return next;
          });
        }
      });

    const resumeQueuedMessages: QueueServiceShape["resumeQueuedMessages"] = (
      sessionId,
    ) =>
      Effect.gen(function* () {
        yield* lookupSession(sessionId);
        yield* setPaused(sessionId, false);
        yield* flushQueuedMessages(sessionId);
      });

    const pauseAfterInterrupt = (sessionId: SessionId) =>
      Effect.gen(function* () {
        if ((yield* listRows(sessionId)).length > 0) {
          yield* setPaused(sessionId, true);
        }
      });

    const shutdown = (sessionId: SessionId) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(pubsubs);
        const pubsub = current.get(sessionId);
        if (pubsub === undefined) return;
        yield* PubSub.shutdown(pubsub);
        yield* Ref.update(pubsubs, (entries) => {
          const next = new Map(entries);
          next.delete(sessionId);
          return next;
        });
      });

    const service = {
      listQueuedMessages,
      streamQueuedMessages,
      addQueuedMessage,
      updateQueuedMessage,
      deleteQueuedMessage,
      sendQueuedMessageNow,
      reorderQueuedMessages,
      flushQueuedMessages,
      resumeQueuedMessages,
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
