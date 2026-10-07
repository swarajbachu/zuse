import { readFile } from "node:fs/promises";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Pool } from "pg";
import { expect, test } from "vitest";
import { ReviewStore, ReviewStorePg } from "../../src/review-store.ts";

const url = process.env.ZUSE_TEST_POSTGRES_URL;
test.skipIf(!url)(
	"run cost summaries require every attributed resource to settle and hide other payers",
	async () => {
		const schema = `review_cost_${crypto.randomUUID().replaceAll("-", "")}`;
		const admin = new Pool({ connectionString: url });
		await admin.query(`CREATE SCHEMA ${schema}`);
		const pool = new Pool({
			connectionString: url,
			options: `-c search_path=${schema}`,
		});
		const runtime = ManagedRuntime.make(
			ReviewStorePg.pipe(
				Layer.provide(
					PgClient.layerFrom(
						PgClient.fromPool({ acquire: Effect.succeed(pool) }),
					),
				),
			),
		);
		try {
			const prerequisite = await readFile(
				new URL(
					"../../drizzle/migrations/0003_managed_cloud_machines.sql",
					import.meta.url,
				),
				"utf8",
			);
			const entitlement = prerequisite
				.split("--> statement-breakpoint")
				.find((s) =>
					s.includes('CREATE TABLE IF NOT EXISTS "relay_entitlements"'),
				);
			if (!entitlement) throw Error("missing prerequisite");
			await pool.query(entitlement);
			for (const migration of [
				"0010_cloud_billing_ledger.sql",
				"0039_review_control_plane.sql",
			])
				await pool.query(
					await readFile(
						new URL(`../../drizzle/migrations/${migration}`, import.meta.url),
						"utf8",
					),
				);
			await pool.query(
				"ALTER TABLE relay_cloud_billing_usage RENAME TO api_cloud_billing_usage; ALTER TABLE relay_cloud_billing_periods RENAME TO api_cloud_billing_periods",
			);
			await pool.query(
				"INSERT INTO api_review_enrollments(id,repository_id,repository_full_name,installation_id,kind,owner_id,enabled_by,model_connection_id,settings,enabled,version,created_at_ms,updated_at_ms) VALUES('enroll',1,'org/repo',2,'shared','payer','actor','connection','{}',true,1,1,1)",
			);
			await pool.query(
				"INSERT INTO api_review_runs(id,comparison_key,repository_id,pull_number,owner_id,enrollment_id,enrollment_version,model_connection_id,snapshot,state,created_at_ms,updated_at_ms) VALUES('run','key',1,1,'payer','enroll',1,'connection','{}','completed',1,1)",
			);
			await pool.query(
				"INSERT INTO api_review_attempts(id,run_id,ordinal,owner_id,provider,provider_sandbox_id,allocated_at_ms,stopped_at_ms,maximum_lifetime_ms,lease_token,created_at_ms,lifecycle) VALUES('inference','run',1,'payer','e2b','native-box',1,100,100,'token',1,'{\"maximumCostMicros\":100}')",
			);
			await pool.query(
				"INSERT INTO api_review_native_connections(id,owner_actor_id,state,data) VALUES('connection','actor','ready','{}')",
			);
			await pool.query(
				"INSERT INTO api_review_native_activities(id,connection_id,owner_id,provider,provider_sandbox_id,started_at_ms,stopped_at_ms,deadline_ms,maximum_cost_micros,state,kind,run_id,attempt_id) VALUES('check','connection','payer','e2b','check-box',101,200,200,40,'stopped','check','run','inference')",
			);
			await pool.query(
				"INSERT INTO api_cloud_billing_periods(period_id,account_id,status,currency,period_start,period_end,base_price_micros,included_provider_cost_micros,markup_basis_points,price_catalog_version,overage_cap_micros,created_at,updated_at) VALUES('period','payer','active','USD',0,1000,0,0,500,'v1',1000000,0,0)",
			);
			const store = await runtime.runPromise(ReviewStore);
			expect(await store.getRunCosts("intruder", ["run"])).toEqual({});
			expect(await store.getRunCosts("payer", [])).toEqual({});
			expect(await store.getRunCosts("payer", ["run"])).toEqual({
				run: { estimatedCostMicros: 140 },
			});
			const usage = async (
				id: string,
				resource: string,
				cost: number,
				status: string,
			) =>
				pool.query(
					"INSERT INTO api_cloud_billing_usage(entry_id,period_id,account_id,resource_kind,resource_id,provider,started_at,ended_at,vcpu_count,memory_mib,provider_cost_micros,status,created_at) VALUES($1,'period','payer','review',$2,'e2b',1,200,2,4096,$3,$4,201)",
					[id, resource, cost, status],
				);
			await usage("u1", "inference", 55, "confirmed");
			expect(
				(await store.getRunCosts("payer", ["run"])).run?.settledCostMicros,
			).toBeUndefined();
			await usage("u2", "check", 25, "provisional");
			expect(
				(await store.getRunCosts("payer", ["run"])).run?.settledCostMicros,
			).toBeUndefined();
			await pool.query(
				"UPDATE api_cloud_billing_usage SET status='confirmed' WHERE entry_id='u2'",
			);
			expect(await store.getRunCosts("payer", ["run"])).toEqual({
				run: { estimatedCostMicros: 140, settledCostMicros: 85 },
			});
			await pool.query(
				"UPDATE api_review_native_activities SET stopped_at_ms=NULL,state='running' WHERE id='check'",
			);
			expect(
				(await store.getRunCosts("payer", ["run"])).run?.settledCostMicros,
			).toBeUndefined();
		} finally {
			await runtime.dispose();
			await pool.end();
			await admin.query(`DROP SCHEMA ${schema} CASCADE`);
			await admin.end();
		}
	},
);
