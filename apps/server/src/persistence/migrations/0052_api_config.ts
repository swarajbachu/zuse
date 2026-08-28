import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Hard-cut the persisted hosted control-plane identity from Relay to API.
 * Shipped Relay migrations remain immutable; this migration preserves their
 * data while changing the current schema and canonical deployment URLs.
 */
export const Migration0052ApiConfig = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`ALTER TABLE relay_config RENAME TO api_config`;
	yield* sql`ALTER TABLE api_config RENAME COLUMN relay_url TO api_url`;
	yield* sql`ALTER TABLE api_config RENAME COLUMN relay_issuer TO api_issuer`;
	yield* sql`ALTER TABLE api_config RENAME COLUMN relay_mint_public_key TO api_mint_public_key`;
	yield* sql`
		UPDATE api_config
		SET api_url = CASE api_url
				WHEN 'https://relay.stuff.md' THEN 'https://api.zuse.sh'
				WHEN 'https://relay-staging.stuff.md' THEN 'https://api-staging.stuff.md'
				ELSE api_url
			END,
			api_issuer = CASE api_issuer
				WHEN 'https://relay.stuff.md' THEN 'https://api.zuse.sh'
				WHEN 'https://relay-staging.stuff.md' THEN 'https://api-staging.stuff.md'
				ELSE api_issuer
			END
	`;
});
