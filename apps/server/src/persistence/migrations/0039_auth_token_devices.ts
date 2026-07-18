import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Identifies a physical client so pairing it again rotates one credential. */
export const Migration0039AuthTokenDevices = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;

	yield* sql`ALTER TABLE auth_tokens ADD COLUMN device_id TEXT`;
	yield* sql`
    CREATE UNIQUE INDEX idx_auth_tokens_active_device
      ON auth_tokens(device_id)
      WHERE device_id IS NOT NULL AND revoked_at IS NULL
  `;
});
