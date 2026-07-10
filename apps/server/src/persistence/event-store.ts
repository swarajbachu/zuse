import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { SqlError } from "effect/unstable/sql/SqlError";

/**
 * Append-only event store in front of the chat tables (spec: remote
 * multi-client, D1). `events` is the source of truth; `messages` (and the
 * activity stamps on `sessions`/`chats`) are projections derived from it.
 *
 * v1 routes ONLY `MessagePersisted` through the log — session/chat lifecycle
 * UPDATEs (status, cursor, titles, archival) stay inline CRUD, and the
 * composer queue is explicitly out (its rows are ephemeral scheduling state).
 */

export type StreamKind = "session";

export type EventType = "MessagePersisted";

/**
 * `contentJson` carries the exact stored string (never re-normalized JSON),
 * so replaying an event reproduces `messages.content_json` byte-for-byte.
 */
export const MessagePersistedPayload = Schema.Struct({
  messageId: Schema.String,
  sessionId: Schema.String,
  role: Schema.String,
  kind: Schema.String,
  contentJson: Schema.String,
  parentItemId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type MessagePersistedPayload = typeof MessagePersistedPayload.Type;

const decodePayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(MessagePersistedPayload),
);

export interface AppendEventInput {
  readonly streamKind: StreamKind;
  readonly streamId: string;
  readonly type: EventType;
  readonly payload: MessagePersistedPayload;
  readonly actor: string | null;
}

const APPEND_RETRY_TIMES = 5;

/**
 * True only for a violation of the `(stream_kind, stream_id, stream_version)`
 * optimistic-concurrency index — the one conflict `appendEvent` may retry
 * (recomputing MAX+1). An `event_id` collision must NOT retry: same input
 * would collide forever.
 *
 * Error shapes differ per driver: node:sqlite throws
 * `{ code: "ERR_SQLITE_ERROR", errcode: 2067, message: "UNIQUE constraint failed: events.stream_kind, ..." }`;
 * bun:sqlite (tests) throws `{ code: "SQLITE_CONSTRAINT_UNIQUE", errno: 2067 }`.
 */
export const isStreamVersionConflict = (error: unknown): boolean => {
  if (!(error instanceof SqlError)) return false;
  const cause = error.cause as {
    readonly code?: string;
    readonly errcode?: number;
    readonly errno?: number;
    readonly message?: string;
  } | null;
  if (cause === null || typeof cause !== "object") return false;
  const isUniqueViolation =
    cause.errcode === 2067 ||
    cause.errno === 2067 ||
    cause.code === "SQLITE_CONSTRAINT_UNIQUE";
  return (
    isUniqueViolation &&
    String(cause.message ?? "").includes("events.stream_version")
  );
};

interface EventRow {
  readonly sequence: number;
  readonly type: string;
  readonly payload_json: string;
}

export interface EventStore {
  /**
   * Append one event and project it, atomically, returning the assigned
   * global sequence. Retries (bounded) on a concurrent-writer version
   * conflict, recomputing `stream_version = MAX+1` each attempt.
   */
  readonly appendEvent: (
    input: AppendEventInput,
  ) => Effect.Effect<number, SqlError>;
  /** Apply one event's projection writes. Idempotent (`INSERT OR IGNORE`). */
  readonly projectEvent: (
    sequence: number,
    payload: MessagePersistedPayload,
  ) => Effect.Effect<void, SqlError>;
  /**
   * Replay any events past the projector high-water mark. In steady state
   * this is a no-op (append and projection share a transaction); it exists
   * so a projection can be rebuilt deterministically — drop `messages`,
   * reset the watermark, boot.
   */
  readonly catchup: Effect.Effect<void, SqlError>;
}

export const PROJECTOR_WATERMARK_KEY = "projector_watermark";

export const makeEventStore = (sql: SqlClient.SqlClient): EventStore => {
  const projectEvent = (
    sequence: number,
    payload: MessagePersistedPayload,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      yield* sql`
        INSERT OR IGNORE INTO messages
          (id, session_id, role, kind, content_json, parent_item_id, created_at, sequence)
        VALUES
          (${payload.messageId}, ${payload.sessionId}, ${payload.role},
           ${payload.kind}, ${payload.contentJson}, ${payload.parentItemId},
           ${payload.createdAt}, ${sequence})
      `;
      yield* sql`
        UPDATE sessions SET updated_at = ${payload.createdAt}
        WHERE id = ${payload.sessionId}
      `;
      // Advance the owning chat's activity clock (read/unread signal); chat
      // `updated_at` (sidebar ordering) is intentionally untouched.
      yield* sql`
        UPDATE chats SET last_message_at = ${payload.createdAt}
        WHERE id = (SELECT chat_id FROM sessions WHERE id = ${payload.sessionId})
      `;
      // The high-water mark lives in app_state and moves inside the same
      // transaction as the projection. It is deliberately NOT derived from
      // max(messages.sequence): deleting a chat cascade-deletes projected
      // rows while their events remain, and a max()-derived mark would
      // re-project that deleted history on the next boot.
      yield* sql`
        INSERT OR REPLACE INTO app_state (key, value)
        VALUES (${PROJECTOR_WATERMARK_KEY}, ${String(sequence)})
      `;
    });

  const appendEvent = (
    input: AppendEventInput,
  ): Effect.Effect<number, SqlError> =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const versionRows = yield* sql<{ readonly next: number }>`
            SELECT COALESCE(MAX(stream_version), 0) + 1 AS next FROM events
            WHERE stream_kind = ${input.streamKind}
              AND stream_id = ${input.streamId}
          `;
          const next = versionRows[0]?.next ?? 1;
          const inserted = yield* sql<{ readonly sequence: number }>`
            INSERT INTO events
              (event_id, stream_kind, stream_id, stream_version, type,
               occurred_at, actor, payload_json)
            VALUES
              (${crypto.randomUUID()}, ${input.streamKind}, ${input.streamId},
               ${next}, ${input.type}, ${new Date().toISOString()},
               ${input.actor}, ${JSON.stringify(input.payload)})
            RETURNING sequence
          `;
          const sequence = inserted[0]!.sequence;
          yield* projectEvent(sequence, input.payload);
          return sequence;
        }),
      )
      .pipe(
        Effect.retry({
          while: isStreamVersionConflict,
          times: APPEND_RETRY_TIMES,
        }),
      );

  const catchup: Effect.Effect<void, SqlError> = Effect.gen(function* () {
    const watermarkRows = yield* sql<{ readonly value: string }>`
      SELECT value FROM app_state WHERE key = ${PROJECTOR_WATERMARK_KEY}
    `;
    const since = Number(watermarkRows[0]?.value ?? 0);
    // Skip events whose session no longer exists: OR IGNORE does not cover
    // FK violations, and a rebuild must not resurrect deleted history.
    const pending = yield* sql<EventRow>`
      SELECT e.sequence, e.type, e.payload_json FROM events e
      WHERE e.sequence > ${since}
        AND e.type = 'MessagePersisted'
        AND e.stream_kind = 'session'
        AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.stream_id)
      ORDER BY e.sequence ASC
    `;
    yield* Effect.forEach(
      pending,
      (event) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const payload = yield* decodePayload(event.payload_json).pipe(
              // A payload that fails to decode means a corrupt event log —
              // stop the boot loudly rather than project garbage.
              Effect.orDie,
            );
            yield* projectEvent(event.sequence, payload);
          }),
        ),
      { discard: true },
    );
    if (pending.length > 0) {
      yield* Effect.logInfo(
        `projector catchup: replayed ${pending.length} event(s)`,
      );
    }
  });

  return { appendEvent, projectEvent, catchup };
};
