import { readFile } from "node:fs/promises";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Pool } from "pg";
import { expect, test } from "vitest";
import { ApiStore, ApiStorePg } from "../../src/store.ts";

const url = process.env.ZUSE_TEST_POSTGRES_URL;
test.skipIf(!url)(
	"profile handles are atomic and snapshots survive a store restart",
	async () => {
		const schema = `usage_profiles_${crypto.randomUUID().replaceAll("-", "")}`;
		const admin = new Pool({ connectionString: url });
		await admin.query(`CREATE SCHEMA ${schema}`);
		const pool = new Pool({
			connectionString: url,
			options: `-c search_path=${schema}`,
		});
		const makeRuntime = () =>
			ManagedRuntime.make(
				ApiStorePg.pipe(
					Layer.provide(
						PgClient.layerFrom(
							PgClient.fromPool({ acquire: Effect.succeed(pool) }),
						),
					),
				),
			);
		let runtime = makeRuntime();
		const record = {
			accountId: "alice",
			published: true,
			profile: {
				handle: "sample-dev",
				displayName: "Sample Developer",
				github: "",
				year: 2026,
				generatedAt: "2026-01-03T12:00:00.000Z",
				sessionCount: 0,
				days: [],
				models: [],
				breakdown: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					reasoning: 0,
				},
				sources: [],
				months: [],
				projectCount: 0,
				sessionMinutes: { median: 0, longest: 0 },
				cost: null,
				hours: null,
				publishedAt: 1,
				updatedAt: 1,
			},
		};
		try {
			await pool.query(
				await readFile(
					new URL(
						"../../drizzle/migrations/0048_public_usage_profiles.sql",
						import.meta.url,
					),
					"utf8",
				),
			);
			let store = await runtime.runPromise(ApiStore);
			const claimed = await Promise.all([
				runtime.runPromise(store.saveUsageProfile(record)),
				runtime.runPromise(
					store.saveUsageProfile({ ...record, accountId: "bob" }),
				),
			]);
			expect(claimed.filter((result) => result === "saved")).toHaveLength(1);
			const owner = claimed[0] === "saved" ? "alice" : "bob";
			expect(
				await runtime.runPromise(
					store.saveUsageProfile({
						...record,
						accountId: owner,
						profile: { ...record.profile, handle: "another-handle" },
					}),
				),
			).toBe("handle_unavailable");
			await runtime.runPromise(
				store.saveUsageProfile({
					...record,
					accountId: owner,
					profile: {
						...record.profile,
						displayName: "Updated",
						publishedAt: 20,
						updatedAt: 20,
					},
				}),
			);
			await runtime.dispose();
			runtime = makeRuntime();
			store = await runtime.runPromise(ApiStore);
			expect(
				await runtime.runPromise(
					store.findPublicUsageProfile(record.profile.handle),
				),
			).toMatchObject({
				displayName: "Updated",
				publishedAt: 1,
				updatedAt: 20,
			});
			await runtime.runPromise(store.unpublishUsageProfile(owner));
			expect(
				await runtime.runPromise(
					store.findPublicUsageProfile(record.profile.handle),
				),
			).toBeNull();
			expect(
				await runtime.runPromise(
					store.saveUsageProfile({ ...record, accountId: "third-account" }),
				),
			).toBe("handle_unavailable");
			expect(
				await runtime.runPromise(
					store.saveUsageProfile(record, { expectedUpdatedAt: 20 }),
				),
			).toBe("changed");
		} finally {
			await runtime.dispose();
			await pool.end();
			await admin.query(`DROP SCHEMA ${schema} CASCADE`);
			await admin.end();
		}
	},
);
