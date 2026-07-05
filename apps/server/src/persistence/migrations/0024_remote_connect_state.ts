import { SqlClient } from "@effect/sql";
import { Effect } from "effect";

/**
 * Remote/multi-client link state.
 *
 * This intentionally lives at 0024 because some developer DBs already applied
 * migration id 23 as `chat_lineage`. The body is idempotent so it repairs both
 * fresh and partially-upgraded databases.
 */
export const Migration0024RemoteConnectState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const identityColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(environment_identity)
  `;
  const hasIdentityColumn = (name: string): boolean =>
    identityColumns.some((column) => column.name === name);

  if (!hasIdentityColumn("signing_secret")) {
    yield* sql`
      ALTER TABLE environment_identity
        ADD COLUMN signing_secret TEXT
    `;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS relay_config (
      environment_id         TEXT PRIMARY KEY,
      relay_url              TEXT NOT NULL,
      relay_issuer           TEXT NOT NULL,
      environment_credential TEXT NOT NULL,
      updated_at             TEXT NOT NULL
    )
  `;
});
