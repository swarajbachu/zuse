import { readFile } from "node:fs/promises";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Pool } from "pg";
import { expect, test } from "vitest";
import {
	ReviewBillingAttribution,
	ReviewBillingAttributionLive,
} from "../../src/review-billing-attribution.ts";

const url = process.env.ZUSE_TEST_POSTGRES_URL;
test.skipIf(!url)(
	"delayed provider windows keep their original payer across native sandbox reuse and deletion",
	async () => {
		const schema = `review_billing_${crypto.randomUUID().replaceAll("-", "")}`;
		const admin = new Pool({ connectionString: url });
		await admin.query(`CREATE SCHEMA ${schema}`);
		const pool = new Pool({
			connectionString: url,
			options: `-c search_path=${schema}`,
		});
		const runtime = ManagedRuntime.make(
			ReviewBillingAttributionLive.pipe(
				Layer.provide(
					PgClient.layerFrom(
						PgClient.fromPool({ acquire: Effect.succeed(pool) }),
					),
				),
			),
		);
		try {
			await pool.query(
				await readFile(
					new URL(
						"../../drizzle/migrations/0039_review_control_plane.sql",
						import.meta.url,
					),
					"utf8",
				),
			);
			await pool.query(
				"INSERT INTO api_review_native_connections(id,owner_actor_id,state,data) VALUES('connection','actor','revoked','{}')",
			);
			await pool.query(
				"INSERT INTO api_review_native_activities(id,connection_id,owner_id,provider,provider_sandbox_id,started_at_ms,stopped_at_ms,deadline_ms,maximum_cost_micros,state) VALUES ('login','connection','personal','e2b','reused',100,200,300,10,'stopped'),('later','connection','organization','e2b','reused',300,400,500,10,'stopped'),('child','connection','organization','e2b','child-box',400,NULL,500,10,'running')",
			);
			const store = await runtime.runPromise(ReviewBillingAttribution);
			const window = {
				provider: "e2b",
				providerSandboxId: "reused",
				internalResourceId: "connection",
				startedAtMs: 110,
				endedAtMs: 190,
			};
			expect(await store.resolve(window)).toEqual({
				accountId: "personal",
				resourceId: "login",
				providerSandboxId: "reused",
			});
			expect(
				await store.resolve({ ...window, startedAtMs: 310, endedAtMs: 390 }),
			).toEqual({
				accountId: "organization",
				resourceId: "later",
				providerSandboxId: "reused",
			});
			expect(await store.resolve({ ...window, endedAtMs: 390 })).toBeNull();
			expect(
				await store.resolve({
					...window,
					internalResourceId: "another-tenant",
				}),
			).toBeNull();
			const child = {
				...window,
				providerSandboxId: "child-box",
				internalResourceId: "child",
				startedAtMs: 410,
				endedAtMs: 490,
			};
			expect(await store.resolve(child)).toBeNull();
			await pool.query(
				"UPDATE api_review_native_activities SET stopped_at_ms=500,state='stopped' WHERE id='child'",
			);
			expect(await store.resolve(child)).toEqual({
				accountId: "organization",
				resourceId: "child",
				providerSandboxId: "child-box",
			});
			await pool.query(
				"INSERT INTO api_review_native_activities(id,connection_id,owner_id,provider,provider_sandbox_id,started_at_ms,stopped_at_ms,deadline_ms,maximum_cost_micros,state) VALUES ('overlap','connection','wrong','e2b','reused',100,200,300,10,'stopped')",
			);
			expect(await store.resolve(window)).toBeNull();
		} finally {
			await runtime.dispose();
			await pool.end();
			await admin.query(`DROP SCHEMA ${schema} CASCADE`);
			await admin.end();
		}
	},
);
