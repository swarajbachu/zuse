import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * Event-sourcing core: an append-only `events` table becomes the source of
 * truth for chat history; `messages` becomes a projection of it.
 *
 * - `sequence` (INTEGER PK AUTOINCREMENT) is the global monotonic cursor —
 *   the unit of client resume (`sinceSequence`). AUTOINCREMENT guarantees
 *   strictly-increasing assignment that `created_at` never did.
 * - `stream_version` is a per-stream 1..N counter enforced by the composite
 *   unique index — the optimistic-concurrency guard for multi-writer appends.
 * - Backfill synthesizes one `MessagePersisted` event per existing message
 *   in `(created_at, rowid)` order (SQLite honors ORDER BY on INSERT..SELECT,
 *   so sequence assignment follows that order). `event_id = 'backfill:'||id`
 *   makes stamping the assigned sequence back onto `messages` a plain join.
 * - The projector high-water mark lives in `app_state` — NOT
 *   `max(messages.sequence)`, because deleting a chat/session cascade-deletes
 *   projected rows while their events remain; a max()-derived mark would
 *   re-project deleted history on the next boot.
 */
export const Migration0020Events = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE events (
      sequence       INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id       TEXT NOT NULL UNIQUE,
      stream_kind    TEXT NOT NULL,
      stream_id      TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      type           TEXT NOT NULL,
      occurred_at    TEXT NOT NULL,
      actor          TEXT,
      payload_json   TEXT NOT NULL,
      UNIQUE (stream_kind, stream_id, stream_version)
    )
  `;
  yield* sql`
    CREATE INDEX idx_events_stream
      ON events(stream_kind, stream_id, sequence)
  `;

  yield* sql`ALTER TABLE messages ADD COLUMN sequence INTEGER`;
  yield* sql`
    CREATE INDEX idx_messages_session_sequence
      ON messages(session_id, sequence)
  `;

  yield* sql`
    INSERT INTO events
      (event_id, stream_kind, stream_id, stream_version, type, occurred_at, actor, payload_json)
    SELECT
      'backfill:' || m.id,
      'session',
      m.session_id,
      ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.created_at, m.rowid),
      'MessagePersisted',
      m.created_at,
      NULL,
      json_object(
        'messageId', m.id,
        'sessionId', m.session_id,
        'role', m.role,
        'kind', m.kind,
        'contentJson', m.content_json,
        'parentItemId', m.parent_item_id,
        'createdAt', m.created_at
      )
    FROM messages m
    ORDER BY m.created_at, m.rowid
  `;
  yield* sql`
    UPDATE messages
    SET sequence = (
      SELECT e.sequence FROM events e
      WHERE e.event_id = 'backfill:' || messages.id
    )
  `;

  yield* sql`
    INSERT OR REPLACE INTO app_state (key, value)
    VALUES (
      'projector_watermark',
      (SELECT CAST(COALESCE(MAX(sequence), 0) AS TEXT) FROM events)
    )
  `;
});
