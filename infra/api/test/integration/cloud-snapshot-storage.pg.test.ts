import { PgClient } from "@effect/sql-pg";
import { CLOUD_WORKSPACE_OFFER_ID } from "@zuse/contracts";
import {
	makeSandboxProviders,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { makeSandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { Client, Pool } from "pg";
import { expect, it } from "vitest";
import {
	CloudBillingStore,
	CloudBillingStorePg,
} from "../../src/cloud-billing-store.ts";
import {
	assertSnapshotUsable,
	deleteRetainedSnapshot,
	prepareSnapshotIntent,
	promoteRetainedSnapshot,
	reconcileSnapshotStorage,
	withSnapshotLifecycleLock,
} from "../../src/cloud-snapshot-storage.ts";
import { SNAPSHOT_MONTH_MS } from "../../src/cloud-snapshot-store.ts";
import {
	type CloudProjectBuildRecord,
	CloudWorkspaceStore,
	CloudWorkspaceStorePg,
} from "../../src/cloud-workspace-store.ts";
import { layer as configurationLayer } from "../../src/config.ts";
import { MachineStore, MachineStoreMemory } from "../../src/machine-store.ts";

const connectionString = process.env.ZUSE_TEST_DATABASE_URL;
it.skipIf(!connectionString)(
	"atomically settles concurrent snapshot ticks, rolls back promotion, splits periods and caps Polar overage",
	async () => {
		const db = new Client({ connectionString });
		await db.connect();
		const id = crypto.randomUUID().slice(0, 8);
		const accountId = `snapshot-test-${id}`;
		const projectId = `project-${id}`;
		const start = Date.parse("2026-10-01T00:00:00Z");
		const boundary = start + SNAPSHOT_MONTH_MS / 2;
		const end = start + SNAPSHOT_MONTH_MS;
		const periodId = `cloud:${accountId}:${start}`;
		const secondPeriodId = `cloud:${accountId}:${boundary}`;
		const dbLayer = PgClient.layerFrom(
			PgClient.fromPool({
				acquire: Effect.acquireRelease(
					Effect.sync(() => new Pool({ connectionString })),
					(pool) => Effect.promise(() => pool.end()),
				),
			}),
		);
		const providers = Layer.effect(
			SandboxProviders,
			Effect.gen(function* () {
				const fake = yield* (yield* SandboxProviders).get("fake");
				return yield* makeSandboxProviders({
					registrations: [
						{
							adapter: {
								...fake,
								providerId: "box",
								inspectSnapshot: () => Effect.succeed("ready"),
								deleteSnapshot: () => Effect.void,
							},
						},
					],
					defaultProviderId: "box",
				});
			}),
		).pipe(Layer.provide(makeSandboxProvidersFake()), Layer.orDie);
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(
				Layer.mergeAll(CloudBillingStorePg, CloudWorkspaceStorePg).pipe(
					Layer.provide(dbLayer),
				),
				MachineStoreMemory,
				providers,
				configurationLayer({
					apiIssuer: "https://api.test",
					workosJwksUrl: "https://unused.test/jwks",
					workosIssuer: "https://unused.test",
					mintPrivateKey: Redacted.make("{}"),
					mintPublicKey: "{}",
					cloudSnapshotBillingCutoverAtMs: start,
					cloudBillingEnforcementEnabled: false,
				}),
			),
		);
		try {
			await db.query(
				"INSERT INTO api_cloud_projects(project_id,account_id,repository_identity,repository_url,display_name,default_branch,visibility,git_connection_kind,configuration_digest,state,idempotency_key,created_at,updated_at) VALUES ($1,$2,$1,'https://github.com/test/repo','repo','main','private','github-app','digest','ready',$1,$3,$3)",
				[projectId, accountId, start],
			);
			const billing = await runtime.runPromise(CloudBillingStore);
			const store = await runtime.runPromise(CloudWorkspaceStore);
			const machines = await runtime.runPromise(MachineStore);
			await runtime.runPromise(
				machines.upsertEntitlement({
					entitlementId: id,
					accountId,
					kind: "cloud-workspace",
					offerId: CLOUD_WORKSPACE_OFFER_ID,
					provider: "polar",
					status: "active",
					periodStartMs: boundary,
					paidThroughMs: end + 1,
					createdAtMs: start,
					updatedAtMs: start,
				}),
			);
			for (const p of [
				{ periodId, periodStartMs: start, periodEndMs: boundary },
				{
					periodId: secondPeriodId,
					periodStartMs: boundary,
					periodEndMs: end + 1,
				},
			])
				await runtime.runPromise(
					billing.ensurePeriod({
						...p,
						accountId,
						status: "active",
						overageCapMicros: 100_000,
						nowMs: start,
					}),
				);
			await db.query(
				"UPDATE api_cloud_billing_periods SET included_provider_cost_micros=0 WHERE account_id=$1",
				[accountId],
			);
			const image = (name: string): CloudProjectBuildRecord => ({
				buildId: `${id}-${name}`,
				projectId,
				accountId,
				provider: "box",
				snapshotId: `zuse-${id}-${name}`,
				templateVersion: "v1",
				configurationDigest: "digest",
				state: "ready",
				idempotencyKey: name,
				nextActionAtMs: Number.MAX_SAFE_INTEGER,
				revision: 0,
				createdAtMs: start,
				updatedAtMs: start,
			});
			const first = image("first");
			await runtime.runPromise(
				store.createBuild({
					...first,
					state: "sanitizing",
					snapshotId: undefined,
				}),
			);
			await runtime.runPromise(
				prepareSnapshotIntent(first, first.buildId, start),
			);
			await runtime.runPromise(promoteRetainedSnapshot(first, start));
			const raceAccount = `${accountId}-restore`;
			const raceSnapshot = `zuse-${id}-restore`;
			await runtime.runPromise(
				billing.snapshots.save({
					snapshotId: raceSnapshot,
					provider: "box",
					accountId: raceAccount,
					buildId: "restore",
					state: "retained",
					createdAtMs: start,
					retainedAtMs: start,
					remainder: 0,
					attempts: 0,
					nextAttemptAtMs: start,
				}),
			);
			let signalEntered = () => {};
			const entered = new Promise<void>((resolve) => {
				signalEntered = resolve;
			});
			let signalRelease = () => {};
			const release = new Promise<void>((resolve) => {
				signalRelease = resolve;
			});
			let diskReplaced = false;
			const restore = runtime.runPromise(
				withSnapshotLifecycleLock(
					raceAccount,
					"box",
					Effect.gen(function* () {
						yield* assertSnapshotUsable(raceAccount, "box", raceSnapshot);
						signalEntered();
						yield* Effect.promise(() => release);
						yield* assertSnapshotUsable(raceAccount, "box", raceSnapshot);
						diskReplaced = true;
					}),
				),
			);
			await entered;
			const deletion = runtime.runPromise(
				deleteRetainedSnapshot(raceAccount, raceSnapshot, start + 100),
			);
			try {
				await expect
					.poll(async () =>
						Number(
							(
								await db.query(
									"SELECT count(*) AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid=((hashtextextended($1,0) & 4294967295)::oid) AND classid=(((hashtextextended($1,0) >> 32) & 4294967295)::oid)",
									[`snapshot:${raceAccount}`],
								)
							).rows[0].count,
						),
					)
					.toBe(1);
				expect(
					(
						await runtime.runPromise(
							billing.snapshots.get(raceAccount, raceSnapshot),
						)
					)?.state,
				).toBe("retained");
			} finally {
				signalRelease();
				await Promise.all([restore, deletion]);
			}
			expect(diskReplaced).toBe(true);
			expect(
				(
					await runtime.runPromise(
						billing.snapshots.get(raceAccount, raceSnapshot),
					)
				)?.state,
			).toBe("deleting");
			await db.query("DELETE FROM api_cloud_snapshots WHERE snapshot_id=$1", [
				raceSnapshot,
			]);

			const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
			const { tmpdir } = await import("node:os");
			const { join } = await import("node:path");
			const { fileURLToPath } = await import("node:url");
			const { execFileSync } = await import("node:child_process");
			const capture = mkdtempSync(join(tmpdir(), "zuse-snapshot-inventory-"));
			try {
				const inventoryFile = join(capture, "inventory.json");
				writeFileSync(
					inventoryFile,
					JSON.stringify({
						snapshots: [
							{
								name: first.snapshotId,
								status: "ready",
								sourceSandboxId: "known",
							},
							{
								name: "platform-template",
								status: "ready",
								sourceSandboxId: "unattributed",
							},
						],
					}),
				);
				const report = JSON.parse(
					execFileSync(
						process.execPath,
						[
							fileURLToPath(
								new URL(
									"../../scripts/cloud-snapshot-ops.mjs",
									import.meta.url,
								),
							),
							"report",
						],
						{
							encoding: "utf8",
							env: {
								...process.env,
								DATABASE_URL: connectionString,
								SNAPSHOT_REFERENCE_DATABASE_URL: connectionString,
								SNAPSHOT_INVENTORY_FILE: inventoryFile,
							},
							timeout: 10_000,
						},
					),
				);
				expect(report.providerInventoryAvailable).toBe(true);
				expect(report.referenceEnvironmentChecked).toBe(true);
				expect(
					report.inventory.find(
						(record: { snapshotId: string }) =>
							record.snapshotId === first.snapshotId,
					)?.state,
				).toBe("retained");
				expect(report.untracked).toEqual([
					{
						name: "platform-template",
						status: "ready",
						sourceSandboxId: "unattributed",
						candidateBuildIds: [],
						referenceEnvironmentBuildIds: [],
						autoDelete: false,
					},
				]);
			} finally {
				rmSync(capture, { recursive: true, force: true });
			}

			// A failed transaction cannot switch the active image or checkpoint.
			const second = image("second");
			await runtime.runPromise(
				store.createBuild({
					...second,
					state: "sanitizing",
					snapshotId: undefined,
				}),
			);
			await runtime.runPromise(
				prepareSnapshotIntent(second, second.buildId, start),
			);
			await expect(
				runtime.runPromise(
					billing.snapshots.transaction(
						accountId,
						Effect.gen(function* () {
							yield* promoteRetainedSnapshot(second, start + 12345);
							yield* Effect.fail(new Error("rollback"));
						}),
					),
				),
			).rejects.toThrow("rollback");
			expect(
				(await runtime.runPromise(billing.snapshots.list(accountId))).find(
					(r) => r.snapshotId === first.snapshotId,
				)?.state,
			).toBe("retained");
			expect(
				(await runtime.runPromise(store.getBuild(second.buildId)))?.state,
			).toBe("sanitizing");
			await Promise.all(
				Array.from({ length: 6 }, () =>
					runtime.runPromise(reconcileSnapshotStorage(end)),
				),
			);
			const costs = await db.query(
				"SELECT period_id,SUM(provider_cost_micros)::bigint AS total,COUNT(*)::int AS count FROM api_cloud_billing_usage WHERE account_id=$1 GROUP BY period_id ORDER BY period_id",
				[accountId],
			);
			expect(costs.rows).toHaveLength(2);
			expect(costs.rows.map((row) => Number(row.total))).toEqual([
				850_000, 850_000,
			]);
			expect(costs.rows.every((row) => row.count === 1)).toBe(true);
			const overage = await db.query(
				"SELECT SUM(amount_cents)::int AS total FROM api_cloud_billing_outbox WHERE account_id=$1",
				[accountId],
			);
			expect(overage.rows[0].total).toBe(20);
			const absorbed = await db.query(
				"SELECT SUM(amount_micros)::bigint AS total FROM api_cloud_billing_ledger WHERE account_id=$1 AND kind='overshoot-absorbed'",
				[accountId],
			);
			expect(Number(absorbed.rows[0].total)).toBe(1_585_000);
			const exports = await db.query(
				"SELECT event_id,payload FROM api_cloud_usage_outbox WHERE payload->>'accountId'=$1",
				[accountId],
			);
			expect(exports.rows).toHaveLength(2);
			const event = exports.rows[0].payload;
			await runtime.runPromise(
				billing.retryUsageExport(event.eventId, end, "timeout"),
			);
			const retry = await db.query(
				"SELECT event_id,payload FROM api_cloud_usage_outbox WHERE event_id=$1",
				[event.eventId],
			);
			expect(retry.rows[0].event_id).toBe(event.eventId);
			expect(retry.rows[0].payload.occurredAtMs).toBe(event.occurredAtMs);
		} finally {
			await runtime.dispose();
			await db.query(
				"DELETE FROM api_cloud_usage_outbox WHERE payload->>'accountId'=$1",
				[accountId],
			);
			for (const table of [
				"api_cloud_billing_outbox",
				"api_cloud_billing_ledger",
				"api_cloud_billing_usage",
				"api_cloud_billing_periods",
				"api_cloud_snapshots",
				"api_cloud_projects",
			])
				await db.query(`DELETE FROM ${table} WHERE account_id=$1`, [accountId]);
			await db.query(
				"DELETE FROM api_provider_event_finalizations WHERE event_id LIKE $1",
				[`snapshot:zuse-${id}%`],
			);
			await db.query(
				"DELETE FROM api_provider_usage_events WHERE event_id LIKE $1",
				[`snapshot:zuse-${id}%`],
			);
			await db.end();
		}
	},
);

it.skipIf(!connectionString)(
	"backfills only the newest ready image as retained and preserves unfinished publication",
	async () => {
		const { readFileSync } = await import("node:fs");
		const db = new Client({ connectionString });
		await db.connect();
		const schema = `snapshot_migration_${crypto.randomUUID().replaceAll("-", "")}`;
		try {
			await db.query("BEGIN");
			await db.query(`CREATE SCHEMA ${schema}`);
			await db.query(`SET LOCAL search_path TO ${schema}`);
			await db.query(
				"CREATE TABLE api_cloud_project_builds (provider text, snapshot_id text, account_id text, build_id text, state text, created_at bigint, updated_at bigint)",
			);
			await db.query(
				"INSERT INTO api_cloud_project_builds VALUES ('box','old','account','old','ready',1,1),('box','new','account','new','ready',2,2),('box','pending','account','pending','sanitizing',3,3),('boxd','other','other','other','ready',1,1)",
			);
			const before = Date.now();
			await db.query(
				readFileSync(
					new URL(
						"../../drizzle/migrations/0037_cloud_snapshot_storage.sql",
						import.meta.url,
					),
					"utf8",
				),
			);
			const result = await db.query(
				"SELECT snapshot_id,state,record FROM api_cloud_snapshots ORDER BY snapshot_id",
			);
			expect(result.rows.map((row) => [row.snapshot_id, row.state])).toEqual([
				["new", "retained"],
				["old", "deleting"],
				["pending", "creating"],
			]);
			expect(result.rows[0].record.retainedAtMs).toBeGreaterThanOrEqual(before);
			expect(result.rows[1].record.retainedAtMs).toBeUndefined();
			await db.query("SAVEPOINT immutable_price");
			await expect(
				db.query("UPDATE api_snapshot_price_schedule SET monthly_micros=1"),
			).rejects.toThrow("immutable");
			await db.query("ROLLBACK TO SAVEPOINT immutable_price");
			await expect(
				db.query(
					"INSERT INTO api_cloud_snapshots VALUES ('box','duplicate','account','duplicate','retained',0,'{}')",
				),
			).rejects.toThrow();
		} finally {
			await db.query("ROLLBACK");
			await db.end();
		}
	},
);
