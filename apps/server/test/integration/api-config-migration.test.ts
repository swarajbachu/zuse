import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";

import { Migration0052ApiConfig } from "../../src/persistence/migrations/0052_api_config.ts";

describe("API configuration migration", () => {
	it("preserves connection data and rewrites canonical hosted origins", async () => {
		const runtime = ManagedRuntime.make(sqliteLayer({ filename: ":memory:" }));
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
						CREATE TABLE relay_config (
							environment_id TEXT PRIMARY KEY,
							relay_url TEXT NOT NULL,
							relay_issuer TEXT NOT NULL,
							environment_credential TEXT NOT NULL,
							label TEXT,
							connector_token TEXT,
							tunnel_hostname TEXT,
							relay_mint_public_key TEXT,
							updated_at TEXT NOT NULL
						)
					`;
					yield* sql`
						INSERT INTO relay_config
							(environment_id, relay_url, relay_issuer,
							 environment_credential, label, connector_token,
							 tunnel_hostname, relay_mint_public_key, updated_at)
						VALUES ('env-production', 'https://relay.stuff.md',
							'https://relay.stuff.md', 'credential', 'Production',
							'connector', 'zenv.stuff.md', 'public-key', 'now')
					`;
				}),
			);

			await runtime.runPromise(Migration0052ApiConfig);

			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const tables = yield* sql<{ readonly name: string }>`
						SELECT name FROM sqlite_master
						WHERE type = 'table' AND name IN ('relay_config', 'api_config')
						ORDER BY name
					`;
					const rows = yield* sql<{
						readonly environment_id: string;
						readonly api_url: string;
						readonly api_issuer: string;
						readonly api_mint_public_key: string | null;
					}>`SELECT environment_id, api_url, api_issuer, api_mint_public_key FROM api_config`;
					return { tables, rows };
				}),
			);

			expect(result.tables).toEqual([{ name: "api_config" }]);
			expect(result.rows).toEqual([
				{
					environment_id: "env-production",
					api_url: "https://api.zuse.sh",
					api_issuer: "https://api.zuse.sh",
					api_mint_public_key: "public-key",
				},
			]);
		} finally {
			await runtime.dispose();
		}
	});
});
