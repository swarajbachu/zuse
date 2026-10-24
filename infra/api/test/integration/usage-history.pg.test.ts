import { readFile } from "node:fs/promises";
import { PgClient } from "@effect/sql-pg";
import type { UsageHistoryRow } from "@zuse/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Pool } from "pg";
import { expect, test } from "vitest";
import { ApiStore, ApiStorePg } from "../../src/store.ts";

const url = process.env.ZUSE_TEST_POSTGRES_URL;
const HOUR_MS = 60 * 60 * 1_000;
const BASE_HOUR = Date.UTC(2026, 0, 1);
const open = (maxAccountRows: number) => ({
	maxAccountRows,
	requireBackupEnabled: false,
});

const makeRow = (
	offsetHours = 0,
	overrides: Partial<UsageHistoryRow> = {},
): UsageHistoryRow => {
	const hour = BASE_HOUR + offsetHours * HOUR_MS;
	return {
		hour: new Date(hour).toISOString(),
		sourceId: "claude",
		model: "model-a",
		session: "a".repeat(32),
		project: "",
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 10,
		cacheCreationTokens: 5,
		reasoningTokens: 2,
		costUsd: null,
		recordCount: 3,
		firstAt: hour + 60_000,
		lastAt: hour + 120_000,
		...overrides,
	};
};

test.skipIf(!url)(
	"usage history keys and backup switch are atomic and rows merge monotonically",
	async () => {
		const schema = `usage_history_${crypto.randomUUID().replaceAll("-", "")}`;
		const admin = new Pool({ connectionString: url });
		await admin.query(`CREATE SCHEMA ${schema}`);
		const pool = new Pool({
			connectionString: url,
			options: `-c search_path=${schema}`,
		});
		const runtime = ManagedRuntime.make(
			ApiStorePg.pipe(
				Layer.provide(
					PgClient.layerFrom(
						PgClient.fromPool({ acquire: Effect.succeed(pool) }),
					),
				),
			),
		);
		try {
			for (const migration of [
				"0048_public_usage_profiles.sql",
				"0049_usage_history.sql",
			])
				await pool.query(
					await readFile(
						new URL(`../../drizzle/migrations/${migration}`, import.meta.url),
						"utf8",
					),
				);
			await pool.query(
				"CREATE TABLE api_github_identities(account_id text); CREATE TABLE api_github_enrollments(account_id text); CREATE TABLE api_organization_domain_enrollments(account_id text); CREATE TABLE api_agent_activity(account_id text); CREATE TABLE api_devices(account_id text); CREATE TABLE api_link_challenges(account_id text); CREATE TABLE api_environments(account_id text)",
			);
			const store = await runtime.runPromise(ApiStore);
			const run = <A>(effect: Effect.Effect<A>) => runtime.runPromise(effect);

			const keys = await Promise.all(
				Array.from({ length: 8 }, (_, index) =>
					run(
						store.getOrCreateUsageHistoryKey(
							"alice",
							index.toString(16).padStart(64, "0"),
						),
					),
				),
			);
			expect(new Set(keys).size).toBe(1);
			expect(
				await run(store.getOrCreateUsageHistoryKey("alice", "f".repeat(64))),
			).toBe(keys[0]);

			expect(
				await run(
					store.upsertUsageHistory(
						"alice",
						[makeRow(0), makeRow(1, { costUsd: 0.25 })],
						open(1_000),
					),
				),
			).toBe("stored");
			await Promise.all([
				run(
					store.upsertUsageHistory(
						"alice",
						[
							makeRow(0, {
								inputTokens: 1,
								outputTokens: 999,
								costUsd: 1.5,
								firstAt: BASE_HOUR,
								lastAt: BASE_HOUR + 1,
							}),
							makeRow(1, { costUsd: null, recordCount: 1 }),
						],
						open(1_000),
					),
				),
				run(
					store.upsertUsageHistory(
						"alice",
						[makeRow(0, { reasoningTokens: 40, lastAt: BASE_HOUR + 9e6 })],
						open(1_000),
					),
				),
			]);
			expect(await run(store.pageUsageHistory("alice", 0, 10))).toEqual({
				rows: [
					makeRow(0, {
						outputTokens: 999,
						reasoningTokens: 40,
						costUsd: 1.5,
						firstAt: BASE_HOUR,
						lastAt: BASE_HOUR + 9e6,
					}),
					makeRow(1, { costUsd: 0.25 }),
				],
				nextCursor: null,
			});

			expect(
				await run(
					store.upsertUsageHistory("alice", [makeRow(2), makeRow(3)], open(3)),
				),
			).toBe("full");
			expect(
				await run(
					store.upsertUsageHistory(
						"alice",
						[makeRow(0, { inputTokens: 500 }), makeRow(2)],
						open(3),
					),
				),
			).toBe("stored");
			await run(store.upsertUsageHistory("bob", [makeRow(0)], open(3)));

			const first = await run(store.pageUsageHistory("alice", 0, 2));
			expect(first.rows.map((row) => row.hour)).toEqual([
				makeRow(0).hour,
				makeRow(1).hour,
			]);
			expect(first.rows[0]?.inputTokens).toBe(500);
			expect(first.nextCursor).toEqual(expect.any(String));
			expect(
				await run(store.pageUsageHistory("alice", Number(first.nextCursor), 2)),
			).toEqual({ rows: [makeRow(2)], nextCursor: null });

			expect(await run(store.deleteUsageHistory("alice"))).toBe(3);
			expect(await run(store.pageUsageHistory("alice", 0, 10))).toEqual({
				rows: [],
				nextCursor: null,
			});
			expect(
				await run(store.getOrCreateUsageHistoryKey("alice", "e".repeat(64))),
			).toBe("e".repeat(64));

			const runtimeUpload = () =>
				run(
					store.upsertUsageHistory("carol", [makeRow(0)], {
						maxAccountRows: 10,
						requireBackupEnabled: true,
					}),
				);
			expect(await run(store.getUsageHistoryBackupEnabled("carol"))).toBe(
				false,
			);
			expect(
				await run(
					store.setUsageHistoryBackupEnabled("carol", false, "c".repeat(64)),
				),
			).toBe(false);
			expect(await run(store.getUsageHistoryRuntimeKey("carol"))).toBeNull();
			expect(await runtimeUpload()).toBe("backup_disabled");
			const enabled = await Promise.all([
				run(store.setUsageHistoryBackupEnabled("carol", true, "1".repeat(64))),
				run(store.setUsageHistoryBackupEnabled("carol", true, "2".repeat(64))),
			]);
			expect(enabled).toEqual([true, true]);
			const carolKey = await run(store.getUsageHistoryRuntimeKey("carol"));
			expect(["1".repeat(64), "2".repeat(64)]).toContain(carolKey);
			expect(
				await run(store.getOrCreateUsageHistoryKey("carol", "3".repeat(64))),
			).toBe(carolKey);
			expect(await runtimeUpload()).toBe("stored");
			await run(
				store.setUsageHistoryBackupEnabled("carol", false, "4".repeat(64)),
			);
			expect(await run(store.getUsageHistoryBackupEnabled("carol"))).toBe(
				false,
			);
			expect(await run(store.getUsageHistoryRuntimeKey("carol"))).toBeNull();
			expect(await runtimeUpload()).toBe("backup_disabled");
			expect(
				(await run(store.pageUsageHistory("carol", 0, 10))).rows,
			).toHaveLength(1);
			await run(
				store.setUsageHistoryBackupEnabled("carol", true, "5".repeat(64)),
			);
			expect(await run(store.getUsageHistoryRuntimeKey("carol"))).toBe(
				carolKey,
			);

			await run(store.deleteAccountData("bob"));
			expect(
				(await run(store.pageUsageHistory("bob", 0, 10))).rows,
			).toHaveLength(0);
			await run(store.deleteAccountData("alice"));
			expect(
				await run(store.getOrCreateUsageHistoryKey("alice", "d".repeat(64))),
			).toBe("d".repeat(64));
		} finally {
			await runtime.dispose();
			await pool.end();
			await admin.query(`DROP SCHEMA ${schema} CASCADE`);
			await admin.end();
		}
	},
);
