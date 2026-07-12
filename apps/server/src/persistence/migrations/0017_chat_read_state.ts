import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * Read/unread tracking for chats.
 *
 * `last_message_at` advances every time a message is persisted in any of the
 * chat's sessions; `last_read_at` advances when the user views the chat. A
 * chat is unread when `last_message_at > last_read_at`. Both are nullable —
 * `last_message_at` is NULL until the first message lands; `last_read_at` is
 * seeded to the creation time so freshly created chats start read.
 *
 * `updated_at` (and therefore sidebar ordering) is intentionally left alone.
 */
export const Migration0017ChatReadState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const chatColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(chats)
  `;
  const hasChatColumn = (name: string): boolean =>
    chatColumns.some((column) => column.name === name);

  if (!hasChatColumn("last_message_at")) {
    yield* sql`ALTER TABLE chats ADD COLUMN last_message_at TEXT`;
  }
  if (!hasChatColumn("last_read_at")) {
    yield* sql`ALTER TABLE chats ADD COLUMN last_read_at TEXT`;
  }
});
