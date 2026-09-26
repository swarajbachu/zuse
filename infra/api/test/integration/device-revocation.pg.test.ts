import { randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Pool, type PoolClient } from "pg";
import { expect, test } from "vitest";
import { ApiStore, ApiStorePg } from "../../src/store.ts";

const url = process.env.ZUSE_TEST_POSTGRES_URL;
test.skipIf(!url)(
	"registration waits for sign-out and rejects its revoked key",
	async () => {
		const schema = `push_test_${randomUUID().replaceAll("-", "")}`;
		const admin = new Pool({ connectionString: url });
		await admin.query(`CREATE SCHEMA ${schema}`);
		const pool = new Pool({
			connectionString: url,
			options: `-c search_path=${schema}`,
			application_name: schema,
		});
		const db = PgClient.layerFrom(
			PgClient.fromPool({ acquire: Effect.succeed(pool) }),
		);
		const runtime = ManagedRuntime.make(
			ApiStorePg.pipe(Layer.provideMerge(db)),
		);
		let blocker: PoolClient | undefined;
		try {
			await pool.query(
				"CREATE TABLE api_devices (device_id text PRIMARY KEY, account_id text, platform text, push_token text, dpop_jwk jsonb, dpop_thumbprint text, updated_at bigint)",
			);
			await pool.query(
				"CREATE TABLE api_revoked_dpop_keys (thumbprint text PRIMARY KEY, revoked_at bigint)",
			);
			const store = await runtime.runPromise(ApiStore);
			const device = {
				deviceId: "phone",
				accountId: "account",
				platform: "ios" as const,
				dpopThumbprint: "old-key",
				pushToken: "token",
				updatedAtMs: 1,
			};
			expect(await runtime.runPromise(store.upsertDevice(device))).toBe(true);
			blocker = await pool.connect();
			await blocker.query("BEGIN");
			await blocker.query(
				"SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
				["mobile-devices:account"],
			);
			await blocker.query("DELETE FROM api_devices WHERE device_id='phone'");
			await blocker.query(
				"INSERT INTO api_revoked_dpop_keys VALUES ('old-key', 1)",
			);
			const lateRegistration = runtime.runPromise(store.upsertDevice(device));
			await expect
				.poll(async () =>
					Number(
						(
							await admin.query(
								"SELECT count(*) FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'",
								[schema],
							)
						).rows[0].count,
					),
				)
				.toBe(1);
			await blocker.query("COMMIT");
			blocker.release();
			blocker = undefined;
			expect(await lateRegistration).toBe(false);
			expect(await runtime.runPromise(store.listDevices("account"))).toEqual(
				[],
			);
			expect(
				await runtime.runPromise(
					store.upsertDevice({ ...device, deviceId: "other" }),
				),
			).toBe(false);
			expect(
				await runtime.runPromise(
					store.upsertDevice({ ...device, dpopThumbprint: "fresh-key" }),
				),
			).toBe(true);
			expect(
				await runtime.runPromise(store.revokeDevice("phone", "account")),
			).toBe(true);
			expect(
				await runtime.runPromise(
					store.upsertDevice({ ...device, dpopThumbprint: "fresh-key" }),
				),
			).toBe(false);
		} finally {
			if (blocker) {
				await blocker.query("ROLLBACK");
				blocker.release();
			}
			await runtime.dispose();
			await pool.end();
			await admin.query(`DROP SCHEMA ${schema} CASCADE`);
			await admin.end();
		}
	},
);
