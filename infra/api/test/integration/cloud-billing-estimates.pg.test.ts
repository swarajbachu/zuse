import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Client, Pool } from "pg";
import { expect, it } from "vitest";
import {
	CloudBillingStore,
	CloudBillingStorePg,
} from "../../src/cloud-billing-store.ts";
import type { RuntimeObservation } from "../../src/cloud-usage-store.ts";

const connectionString = process.env.ZUSE_TEST_DATABASE_URL;
it.skipIf(!connectionString)(
	"persists estimated deductions atomically and replaces them with exact-machine settlement without double counting",
	async () => {
		const db = new Client({ connectionString });
		await db.connect();
		const schema = `estimates_${crypto.randomUUID().replaceAll("-", "")}`;
		await db.query(`CREATE SCHEMA ${schema}`);
		await db.query(`SET search_path=${schema}`);
		const databaseLayer = PgClient.layerFrom(
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
		const layer = CloudBillingStorePg.pipe(Layer.provide(databaseLayer));
		let runtime = ManagedRuntime.make(layer);
		try {
			await db.query("CREATE TABLE api_entitlements (id text)");
			const migration = async (file: string) =>
				await readFile(
					new URL(`../../drizzle/migrations/${file}`, import.meta.url),
					"utf8",
				);
			await db.query(
				(await migration("0010_cloud_billing_ledger.sql")).replaceAll(
					"relay_",
					"api_",
				),
			);
			await db.query(
				"ALTER TABLE api_provider_usage_events ADD COLUMN occurred_at bigint",
			);
			await db.query(await migration("0027_cloud_usage.sql"));
			await db.query(await migration("0029_boxd_estimated_balance.sql"));
			const localUrl = new URL(connectionString ?? "");
			localUrl.searchParams.set("options", `-c search_path=${schema}`);
			const effectiveAt = new Date(Date.now() + 3_600_000).toISOString();
			const install = (cpu: string, at = effectiveAt) =>
				spawnSync(
					process.execPath,
					[
						fileURLToPath(
							new URL("../../scripts/cloud-billing-ops.mjs", import.meta.url),
						),
						"add-boxd-estimate-price",
						"operator-test",
						at,
						cpu,
						"4500",
					],
					{
						env: { PATH: process.env.PATH, DATABASE_URL: localUrl.href },
						encoding: "utf8",
					},
				);
			expect(install("14000").status).toBe(0);
			expect(install("14000").status).toBe(0);
			expect(install("15000").stderr).toContain("immutable");
			expect(install("-1").status).not.toBe(0);
			expect(
				(
					await db.query(
						"SELECT COUNT(*) FROM api_provider_price_schedule WHERE version='operator-test'",
					)
				).rows[0].count,
			).toBe("1");
			await db.query(
				"INSERT INTO api_provider_price_schedule (provider,version,effective_at,cpu_nano_usd_per_second,memory_nano_usd_per_gib_second,created_at) VALUES ('boxd-estimate','test',0,500000000,0,0)",
			);
			let store = await runtime.runPromise(CloudBillingStore);
			const now = Date.now();
			const start = now - 60_000;
			const period = await runtime.runPromise(
				store.ensurePeriod({
					accountId: "account",
					periodId: "period",
					status: "active",
					periodStartMs: start,
					periodEndMs: now + 3_600_000,
					nowMs: start,
				}),
			);
			const observation: RuntimeObservation = {
				accountId: "account",
				resourceKind: "workspace",
				resourceId: "workspace",
				provider: "boxd",
				providerSandboxId: "machine",
				vcpuCount: 2,
				memoryMib: 8192,
				runningSinceMs: start,
				observedAtMs: start,
			};
			const options = { exportRuntime: false, estimateCutoverAtMs: start };
			const record = (time: number) =>
				runtime.runPromise(
					store.recordRuntimeObservation(
						{ ...observation, observedAtMs: time },
						options,
					),
				);
			await Promise.all(Array.from({ length: 8 }, () => record(start)));
			await db.query(
				"ALTER TABLE api_cloud_billing_usage ADD CONSTRAINT fail_estimate CHECK (measurement <> 'estimated')",
			);
			await expect(record(now)).rejects.toThrow();
			expect(
				(
					await db.query(
						"SELECT observation FROM api_cloud_runtime_observations",
					)
				).rows[0].observation.observedAtMs,
			).toBe(start);
			await db.query(
				"ALTER TABLE api_cloud_billing_usage DROP CONSTRAINT fail_estimate",
			);
			await Promise.all(Array.from({ length: 8 }, () => record(now)));
			expect(
				(await db.query("SELECT COUNT(*) FROM api_cloud_billing_usage")).rows[0]
					.count,
			).toBe("1");
			expect(await runtime.runPromise(store.summary(period))).toMatchObject({
				providerCostMicros: 60_000_000,
				estimatedProviderCostMicros: 60_000_000,
				includedRemainingMicros: 0,
				overageChargeMicros: 25_000_000,
				status: "billing-hold",
				usageProvisional: true,
			});
			expect(await runtime.runPromise(store.pendingOutbox(now, 100))).toEqual(
				[],
			);
			expect(
				await runtime.runPromise(store.pendingUsageExports(now, 100)),
			).toEqual([]);
			await runtime.dispose();
			runtime = ManagedRuntime.make(layer);
			store = await runtime.runPromise(CloudBillingStore);
			await record(now);
			await record(start);
			await runtime.runPromise(
				store.recordRuntimeObservation(
					{
						...observation,
						observedAtMs: now + 60_000,
						runningSinceMs: undefined,
					},
					options,
				),
			);
			expect(
				(await runtime.runPromise(store.summary(period)))
					.estimatedProviderCostMicros,
			).toBe(60_000_000);
			const settle = async (
				id: string,
				from: number,
				to: number,
				cost: number,
				sandbox = "machine",
			) => {
				await runtime.runPromise(
					store.recordProviderEvent({
						provider: "boxd",
						eventId: id,
						type: "usage",
						receivedAtMs: now,
						expiresAtMs: now + 100_000,
						payload: {},
					}),
				);
				return runtime.runPromise(
					store.recordProviderExecutionBatch({
						provider: "boxd",
						eventId: id,
						providerExecutionId: id,
						finalizedAtMs: now,
						usage: [
							{
								entryId: id,
								periodId: "period",
								accountId: "account",
								resourceKind: "workspace",
								resourceId: "workspace",
								provider: "boxd",
								providerSandboxId: sandbox,
								providerExecutionId: id,
								startedAt: from,
								endedAt: to,
								providerCostMicros: cost,
								vcpuCount: 2,
								memoryMib: 8192,
								status: "confirmed",
								nowMs: now,
							},
						],
					}),
				);
			};
			await settle("other", start, now, 0, "different-machine");
			expect(
				(await runtime.runPromise(store.summary(period)))
					.estimatedProviderCostMicros,
			).toBe(60_000_000);
			await settle("first", start, start + 30_000, 10_000_000);
			expect(await runtime.runPromise(store.summary(period))).toMatchObject({
				providerCostMicros: 40_000_000,
				estimatedProviderCostMicros: 30_000_000,
				overageChargeMicros: 5_250_000,
				status: "active",
			});
			expect(await settle("first", start, start + 30_000, 10_000_000)).toBe(
				false,
			);
			await settle("second", start + 30_000, now, 12_000_000);
			expect(await runtime.runPromise(store.summary(period))).toMatchObject({
				providerCostMicros: 22_000_000,
				estimatedProviderCostMicros: 0,
				includedRemainingMicros: 13_000_000,
				overageChargeMicros: 0,
				usageProvisional: false,
			});
			expect(
				(
					await runtime.runPromise(store.listUsage("period", undefined, 100))
				).items.every((item) => item.measurement !== "estimated"),
			).toBe(true);
			// Original estimate is retained for audit, even after complete settlement.
			expect(
				(
					await db.query(
						"SELECT COUNT(*) FROM api_cloud_billing_usage WHERE measurement='estimated'",
					)
				).rows[0].count,
			).toBe("1");
		} finally {
			await runtime.dispose();
			await db.query(`DROP SCHEMA ${schema} CASCADE`);
			await db.end();
		}
	},
	30_000,
);
