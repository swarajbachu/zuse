import { SqlClient } from "@effect/sql";
import { Effect } from "effect";

/**
 * LAN authentication state for the headless WebSocket server.
 *
 * Plaintext bearer tokens are returned once when minted. Persistence stores
 * only SHA-256 hashes so a copied SQLite DB does not reveal active bearer
 * credentials. Pairing codes are intentionally not stored here; they live in
 * memory and expire quickly.
 */
export const Migration0021AuthTokens = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE auth_tokens (
      id           TEXT PRIMARY KEY,
      token_hash   TEXT NOT NULL UNIQUE,
      label        TEXT,
      created_at   TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at   TEXT
    )
  `;

  yield* sql`
    CREATE INDEX idx_auth_tokens_active_hash
      ON auth_tokens(token_hash, revoked_at)
  `;

  yield* sql`
    CREATE TABLE environment_identity (
      id         TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    )
  `;
});
