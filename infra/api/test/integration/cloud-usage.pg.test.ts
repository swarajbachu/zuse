import { readFile } from "node:fs/promises";
import { PgClient } from "@effect/sql-pg";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Client, Pool } from "pg";
import { expect, it } from "vitest";
import {
	makeCloudUsageStorePg,
	type RuntimeObservation,
} from "../../src/cloud-usage-store.ts";

const connectionString = process.env.ZUSE_TEST_DATABASE_URL;
it.skipIf(!connectionString)(
	"atomically records usage under concurrency, rollback, and worker restart",
	async () => {
		const db = new Client({ connectionString });
		await db.connect();
		const schema = `usage_${crypto.randomUUID().replaceAll("-", "")}`;
		await db.query(`CREATE SCHEMA ${schema}`);
		const layer = PgClient.layerFrom(
			PgClient.fromPool({
				acquire: Effect.acquireRelease(
					Effect.sync(
						() =>
							new Pool({
								connectionString,
								options: `-c search_path=${schema}`,
							}),
					),
					(pool) => Effect.promise(() => pool.end()),
				),
			}),
		);
		let runtime = ManagedRuntime.make(layer);
		try {
			await db.query(`SET search_path=${schema}`);
			await db.query(
				"CREATE TABLE api_cloud_billing_periods (account_id text, billing_provider text, period_start bigint, period_end bigint)",
			);
			await db.query(
				await readFile(
					new URL(
						"../../drizzle/migrations/0027_cloud_usage.sql",
						import.meta.url,
					),
					"utf8",
				),
			);
			const store = makeCloudUsageStorePg(
				await runtime.runPromise(SqlClient.SqlClient),
			);
			const observation: RuntimeObservation = {
				accountId: "account",
				resourceKind: "workspace",
				resourceId: "workspace",
				provider: "boxd",
				providerSandboxId: "machine",
				runningSinceMs: 1_000,
				observedAtMs: 1_000,
				vcpuCount: 2,
				memoryMib: 8192,
			};
			await Promise.all(
				Array.from({ length: 8 }, () =>
					runtime.runPromise(store.recordRuntimeObservation(observation)),
				),
			);
			// A failed queue insert must roll back the observation watermark too.
			await db.query(
				"ALTER TABLE api_cloud_usage_outbox ADD CONSTRAINT fail_export CHECK (false)",
			);
			await expect(
				runtime.runPromise(
					store.recordRuntimeObservation({
						...observation,
						observedAtMs: 61_000,
					}),
				),
			).rejects.toThrow();
			expect(
				(
					await db.query(
						"SELECT observation FROM api_cloud_runtime_observations",
					)
				).rows[0].observation.observedAtMs,
			).toBe(1_000);
			await db.query(
				"ALTER TABLE api_cloud_usage_outbox DROP CONSTRAINT fail_export",
			);
			await Promise.all(
				Array.from({ length: 8 }, () =>
					runtime.runPromise(
						store.recordRuntimeObservation({
							...observation,
							observedAtMs: 61_000,
						}),
					),
				),
			);
			const pending = await runtime.runPromise(
				store.pendingUsageExports(61_000, 100),
			);
			expect(pending).toHaveLength(1);
			expect(pending[0]?.units).toBe(60_000);
			await runtime.dispose();
			runtime = ManagedRuntime.make(layer);
			const restarted = makeCloudUsageStorePg(
				await runtime.runPromise(SqlClient.SqlClient),
			);
			await runtime.runPromise(
				restarted.recordRuntimeObservation({
					...observation,
					observedAtMs: 61_000,
				}),
			);
			expect(
				await runtime.runPromise(restarted.pendingUsageExports(61_000, 100)),
			).toEqual(pending);
			const event = pending[0];
			if (!event) throw new Error("Missing export");
			await runtime.runPromise(
				restarted.retryUsageExport(event.eventId, 61_000, "unavailable"),
			);
			expect(
				await runtime.runPromise(restarted.pendingUsageExports(61_001, 100)),
			).toEqual([]);
			expect(
				await runtime.runPromise(restarted.pendingUsageExports(121_000, 100)),
			).toEqual(pending);
			await runtime.runPromise(
				restarted.acknowledgeUsageExport(event.eventId, 121_000),
			);
			await runtime.runPromise(restarted.enqueueUsageExport(event, 121_000));
			expect(
				await runtime.runPromise(restarted.pendingUsageExports(121_000, 100)),
			).toEqual([]);
		} finally {
			await runtime.dispose();
			await db.query(`DROP SCHEMA ${schema} CASCADE`);
			await db.end();
		}
	},
	30_000,
);
