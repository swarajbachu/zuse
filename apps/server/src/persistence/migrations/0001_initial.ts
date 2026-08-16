import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * Initial schema for the chat-MVP. Four tables — projects (formerly the
 * workspaces.json file), sessions (one per chat thread), messages (turn-level
 * rows: user / assistant / tool_use / tool_result / error), and app_state
 * (a tiny key-value table for whole-app state like which project is selected).
 *
 * Schema decisions:
 * - All ids are TEXT — they're branded ULID/UUID-shaped strings from the
 *   wire layer; sqlite TEXT keeps the contract honest.
 * - Timestamps are TEXT (ISO-8601). sqlite has no real datetime type; storing
 *   ISO strings is the canonical Effect-SQL convention and `<` / `>` ordering
 *   stays correct.
 * - `messages.content_json` is a JSON blob whose shape varies by `kind`. The
 *   server never queries inside it — it's a pure persisted-event payload.
 * - Indexes target the two hot reads: "list active sessions for project X
 *   ordered by recency" and "list messages for session Y in order".
 */
export const Migration0001Initial = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      default_model TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_sessions_project
      ON sessions(project_id, archived_at, updated_at DESC)
  `;

  yield* sql`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_messages_session
      ON messages(session_id, created_at)
  `;

  yield* sql`
    CREATE TABLE app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `;
});
