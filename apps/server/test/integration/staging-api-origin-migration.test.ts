import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";

import { Migration0055StagingApiOrigin } from "../../src/persistence/migrations/0055_staging_api_origin.ts";

const oldOrigin = "https://api-staging.stuff.md";
const newOrigin = "https://api-staging.zuse.sh";

describe("staging API origin migration", () => {
	it.each([
		["staging", oldOrigin, oldOrigin, newOrigin, newOrigin],
		["already migrated", newOrigin, newOrigin, newOrigin, newOrigin],
		[
			"production",
			"https://api.zuse.sh",
			"https://api.zuse.sh",
			"https://api.zuse.sh",
			"https://api.zuse.sh",
		],
		[
			"custom",
			"https://custom.example",
			"custom-issuer",
			"https://custom.example",
			"custom-issuer",
		],
		["custom issuer", oldOrigin, "custom-issuer", newOrigin, "custom-issuer"],
		[
			"custom URL",
			"https://custom.example",
			oldOrigin,
			"https://custom.example",
			newOrigin,
		],
		[
			"non-exact host",
			`${oldOrigin}.example`,
			`${oldOrigin}.example`,
			`${oldOrigin}.example`,
			`${oldOrigin}.example`,
		],
	])("preserves %s connection data and is replay safe", async (_label, url, issuer, expectedUrl, expectedIssuer) => {
		const runtime = ManagedRuntime.make(sqliteLayer({ filename: ":memory:" }));
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
					CREATE TABLE api_config (
						environment_id TEXT PRIMARY KEY,
						api_url TEXT NOT NULL,
						api_issuer TEXT NOT NULL,
						environment_credential TEXT NOT NULL,
						label TEXT,
						connector_token TEXT,
						tunnel_hostname TEXT,
						api_mint_public_key TEXT,
						updated_at TEXT NOT NULL
					)
				`;
					yield* sql`
					INSERT INTO api_config VALUES (
						'env-test', ${url}, ${issuer}, 'credential', 'My computer',
						'connector', 'zenv-staging.stuff.md', 'public-key', 'before'
					)
				`;
				}),
			);

			for (let attempt = 0; attempt < 2; attempt++) {
				await runtime.runPromise(Migration0055StagingApiOrigin);
				const rows = await runtime.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						return yield* sql`SELECT * FROM api_config`;
					}),
				);
				expect(rows).toEqual([
					{
						environment_id: "env-test",
						api_url: expectedUrl,
						api_issuer: expectedIssuer,
						environment_credential: "credential",
						label: "My computer",
						connector_token: "connector",
						tunnel_hostname: "zenv-staging.stuff.md",
						api_mint_public_key: "public-key",
						updated_at: "before",
					},
				]);
			}
		} finally {
			await runtime.dispose();
		}
	});
});
