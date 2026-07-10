import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

/**
 * Managed Cloudflare tunnels: the relay hands the desktop a `cloudflared`
 * connector token on link. We persist it on the relay config so the connector
 * can be relaunched on every boot (alongside the heartbeat), without re-linking.
 * Idempotent.
 */
export const Migration0026RelayConnectorToken = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(relay_config)
  `;
  if (!columns.some((column) => column.name === "connector_token")) {
    yield* sql`ALTER TABLE relay_config ADD COLUMN connector_token TEXT`;
  }
});
