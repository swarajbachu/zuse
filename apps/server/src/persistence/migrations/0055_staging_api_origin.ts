import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Move saved staging connections to the product domain without touching
 * production, custom endpoints, credentials, or immutable earlier migrations.
 * URLs are pinned here so future profile changes cannot rewrite this migration.
 */
export const Migration0055StagingApiOrigin = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`
		UPDATE api_config
		SET api_url = CASE api_url
				WHEN 'https://api-staging.stuff.md' THEN 'https://api-staging.zuse.sh'
				ELSE api_url
			END,
			api_issuer = CASE api_issuer
				WHEN 'https://api-staging.stuff.md' THEN 'https://api-staging.zuse.sh'
				ELSE api_issuer
			END
		WHERE api_url = 'https://api-staging.stuff.md'
			OR api_issuer = 'https://api-staging.stuff.md'
	`;
});
