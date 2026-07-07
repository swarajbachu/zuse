import { SqlClient } from "@effect/sql";
import { Effect } from "effect";

export const Migration0028RelayMintPublicKey = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(relay_config)
  `;
  const hasMintPublicKeyColumn = columns.some(
    (column) => column.name === "relay_mint_public_key",
  );
  if (!hasMintPublicKeyColumn) {
    yield* sql`ALTER TABLE relay_config ADD COLUMN relay_mint_public_key TEXT`;
  }
});
