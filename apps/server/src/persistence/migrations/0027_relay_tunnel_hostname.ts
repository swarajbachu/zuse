import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * Persist the relay-managed tunnel hostname locally so the desktop can
 * advertise its public endpoint after restart without re-linking.
 * Idempotent.
 */
export const Migration0027RelayTunnelHostname = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(relay_config)
  `;
  if (!columns.some((column) => column.name === "tunnel_hostname")) {
    yield* sql`ALTER TABLE relay_config ADD COLUMN tunnel_hostname TEXT`;
  }
});
