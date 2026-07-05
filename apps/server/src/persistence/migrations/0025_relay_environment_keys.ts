import { SqlClient } from "@effect/sql";
import { Effect } from "effect";

/**
 * Account-relay linking upgrades the environment identity from a symmetric
 * `signing_secret` (unverifiable by the relay) to an Ed25519 keypair: the
 * desktop holds the private key and the relay verifies proofs against the
 * public key. Also carries a friendly `label` on the relay link. Idempotent.
 */
export const Migration0025RelayEnvironmentKeys = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const identityColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(environment_identity)
  `;
  const hasIdentityColumn = (name: string): boolean =>
    identityColumns.some((column) => column.name === name);

  if (!hasIdentityColumn("private_key_jwk")) {
    yield* sql`ALTER TABLE environment_identity ADD COLUMN private_key_jwk TEXT`;
  }
  if (!hasIdentityColumn("public_key_jwk")) {
    yield* sql`ALTER TABLE environment_identity ADD COLUMN public_key_jwk TEXT`;
  }

  const relayColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(relay_config)
  `;
  if (!relayColumns.some((column) => column.name === "label")) {
    yield* sql`ALTER TABLE relay_config ADD COLUMN label TEXT`;
  }
});
