import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * Adds the attachment tables for MVP 0.03's image-input pipeline.
 *
 * `attachments` is the per-blob row written when the renderer uploads an
 * image. The id matches the on-disk filename stem
 * (`<sessionSegment>-<uuid>`); the bytes themselves live under the
 * desktop app's userData directory.
 *
 * `message_attachments` is the join used to keep blobs alive: the GC
 * sweep deletes any attachment that is older than 24 h, has no row in
 * this table, and hasn't been heartbeat by a renderer in the last 90 s.
 *
 * The `remote_*` columns reserve the future cloud-sync shape so the sync
 * worker can land additively without touching message history.
 */
export const Migration0006Attachments = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE attachments (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      mime_type     TEXT NOT NULL,
      size_bytes    INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      remote_url    TEXT,
      remote_key    TEXT,
      remote_status TEXT
    )
  `;

  yield* sql`
    CREATE INDEX idx_attachments_session
      ON attachments(session_id, created_at)
  `;

  yield* sql`
    CREATE TABLE message_attachments (
      message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      attachment_id TEXT NOT NULL REFERENCES attachments(id),
      PRIMARY KEY (message_id, attachment_id)
    )
  `;

  yield* sql`
    CREATE INDEX idx_message_attachments_attachment
      ON message_attachments(attachment_id)
  `;
});
