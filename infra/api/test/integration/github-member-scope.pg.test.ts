import { readFile } from "node:fs/promises";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Pool } from "pg";
import { expect, test } from "vitest";
import {
	CloudWorkspaceStore,
	CloudWorkspaceStorePg,
} from "../../src/cloud-workspace-store.ts";

const url = process.env.ZUSE_TEST_POSTGRES_URL;
test.skipIf(!url)(
	"member repository scopes survive upgrade, reconnect, refresh and store restart",
	async () => {
		const schema = `github_scope_${crypto.randomUUID().replaceAll("-", "")}`;
		const admin = new Pool({ connectionString: url });
		await admin.query(`CREATE SCHEMA ${schema}`);
		const pool = new Pool({
			connectionString: url,
			options: `-c search_path=${schema}`,
		});
		const makeRuntime = () =>
			ManagedRuntime.make(
				CloudWorkspaceStorePg.pipe(
					Layer.provideMerge(
						PgClient.layerFrom(
							PgClient.fromPool({ acquire: Effect.succeed(pool) }),
						),
					),
				),
			);
		let runtime = makeRuntime();
		try {
			await pool.query(
				await readFile(
					new URL(
						"../../drizzle/migrations/0015_github_app_installations.sql",
						import.meta.url,
					),
					"utf8",
				),
			);
			await pool.query(
				"ALTER TABLE relay_cloud_github_installations RENAME TO api_cloud_github_installations",
			);
			await pool.query(
				"INSERT INTO api_cloud_github_installations (account_id,installation_id,github_account_id,account_login,account_type,repository_selection,suspended,created_at,updated_at) VALUES ('legacy',123,99,'acme','Organization','all',false,1,1)",
			);
			await pool.query(
				await readFile(
					new URL(
						"../../drizzle/migrations/0045_github_member_repository_scope.sql",
						import.meta.url,
					),
					"utf8",
				),
			);
			let store = await runtime.runPromise(CloudWorkspaceStore);
			expect(
				await runtime.runPromise(store.listGithubInstallations("legacy")),
			).toMatchObject([{ allowedRepositories: undefined }]);
			const record = {
				accountId: "member",
				installationId: 123,
				githubAccountId: 99,
				accountLogin: "acme",
				accountType: "Organization" as const,
				repositorySelection: "all" as const,
				suspended: false,
				createdAtMs: 1,
				updatedAtMs: 1,
				allowedRepositories: ["acme/writable"],
			};
			await runtime.runPromise(store.saveGithubInstallation(record));
			await runtime.runPromise(
				store.refreshGithubInstallation(
					123,
					{
						githubAccountId: 99,
						accountLogin: "acme",
						accountType: "Organization",
						repositorySelection: "all",
						suspended: false,
					},
					2,
				),
			);
			await runtime.dispose();
			runtime = makeRuntime();
			store = await runtime.runPromise(CloudWorkspaceStore);
			expect(
				await runtime.runPromise(store.listGithubInstallations("member")),
			).toMatchObject([
				{ allowedRepositories: ["acme/writable"], updatedAtMs: 2 },
			]);
			expect(
				await runtime.runPromise(store.listGithubInstallations("legacy")),
			).toMatchObject([{ allowedRepositories: undefined }]);
			await runtime.runPromise(
				store.saveGithubInstallation({
					...record,
					allowedRepositories: ["acme/another"],
					updatedAtMs: 3,
				}),
			);
			expect(
				await runtime.runPromise(store.listGithubInstallations("member")),
			).toMatchObject([{ allowedRepositories: ["acme/another"] }]);
			await expect(
				pool.query(
					"UPDATE api_cloud_github_installations SET allowed_repositories='[]'::jsonb WHERE account_id='member'",
				),
			).rejects.toMatchObject({ code: "23514" });
			await runtime.runPromise(store.removeGithubInstallation("member", 123));
			expect(
				await runtime.runPromise(store.listGithubInstallations("member")),
			).toEqual([]);
		} finally {
			await runtime.dispose();
			await pool.end();
			await admin.query(`DROP SCHEMA ${schema} CASCADE`);
			await admin.end();
		}
	},
);
