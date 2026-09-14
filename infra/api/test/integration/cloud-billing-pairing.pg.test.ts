import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Client, Pool } from "pg";
import { expect, it } from "vitest";
// @ts-expect-error migration scripts run directly as Node ESM
import { ensureBillingIndex } from "../../scripts/ensure-billing-index.mjs";
import {
	CloudBillingStore,
	CloudBillingStorePg,
} from "../../src/cloud-billing-store.ts";

const connectionString = process.env.ZUSE_TEST_DATABASE_URL;
it.skipIf(!connectionString)(
	"persists concurrent billing associations and builds the index without blocking ledger writes",
	async () => {
		const db = new Client({ connectionString });
		const writer = new Client({ connectionString });
		await db.connect();
		await writer.connect();
		const dbLayer = PgClient.layerFrom(
			PgClient.fromPool({
				acquire: Effect.acquireRelease(
					Effect.sync(() => new Pool({ connectionString })),
					(pool) => Effect.promise(() => pool.end()),
				),
			}),
		);
		const runtime = ManagedRuntime.make(
			CloudBillingStorePg.pipe(Layer.provide(dbLayer)),
		);
		const resource = crypto.randomUUID();
		try {
			// This opt-in test requires a disposable, migrated PostgreSQL database.
			await db.query(
				"DROP INDEX CONCURRENTLY IF EXISTS api_provider_usage_events_resource_time_idx",
			);
			const indexPid = (await db.query("SELECT pg_backend_pid() AS pid"))
				.rows[0].pid as number;
			await writer.query("BEGIN");
			await writer.query("SET LOCAL statement_timeout = '3s'");
			await writer.query(
				"INSERT INTO api_provider_usage_events (provider,event_id,type,provider_resource_id,payload,received_at,expires_at,occurred_at) VALUES ('box',$1,'box.ready',$1,'{}',0,99999999,1)",
				[resource],
			);
			const indexBuild = ensureBillingIndex(db);
			await expect
				.poll(
					async () => {
						await writer.query("SELECT pg_stat_clear_snapshot()");
						const activity = await writer.query(
							"SELECT query FROM pg_stat_activity WHERE pid = $1 AND state = 'active'",
							[indexPid],
						);
						return activity.rows[0]?.query as string | undefined;
					},
					{ timeout: 3000 },
				)
				.toContain("CREATE INDEX CONCURRENTLY");
			await writer.query(
				"INSERT INTO api_provider_usage_events (provider,event_id,type,payload,received_at,expires_at) VALUES ('box',$1,'test','{}',0,99999999)",
				[`${resource}-writer`],
			);
			await writer.query("COMMIT");
			await indexBuild;
			await ensureBillingIndex(db);
			const store = await runtime.runPromise(CloudBillingStore);
			const record = async (id: string, type: string, occurredAtMs: number) =>
				runtime.runPromise(
					store.recordProviderEvent({
						provider: "box",
						eventId: resource + id,
						type,
						providerResourceId: resource,
						payload: {},
						receivedAtMs: Date.now(),
						expiresAtMs: Date.now() + 60_000,
						occurredAtMs,
					}),
				);
			await record("-ready2", "box.ready", 3000);
			await record("-close1", "box.archived", 2000);
			await record("-ready1", "box.ready", 1000);
			const pair = () =>
				runtime.runPromise(
					store.pairProviderOpening({
						provider: "box",
						providerResourceId: resource,
						openingType: "box.ready",
						closingEventId: `${resource}-close1`,
						closedAtMs: 2000,
					}),
				);
			const results = await Promise.all([pair(), pair()]);
			expect(results).toEqual(
				Array(2).fill({ eventId: `${resource}-ready1`, startedAtMs: 1000 }),
			);
			await record("-late-ready", "box.ready", 1500);
			expect(await pair()).toEqual(results[0]);
		} finally {
			await writer.query("ROLLBACK");
			await runtime.dispose();
			await db.query(
				"DELETE FROM api_provider_usage_events WHERE event_id LIKE $1",
				[`${resource}%`],
			);
			await writer.end();
			await db.end();
		}
	},
	30_000,
);
