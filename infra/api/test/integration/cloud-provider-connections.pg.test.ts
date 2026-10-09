import { readFile } from "node:fs/promises";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime } from "effect";
import pg from "pg";
import { expect, test } from "vitest";
import {
	CloudProviderConnections,
	CloudProviderConnectionsLive,
	type ProviderConnectionRecord,
} from "../../src/cloud-provider-connections.ts";

const connectionString = process.env.ZUSE_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
	"provider key rotation is atomic, durable and owner-scoped",
	async () => {
		const schema = `byok_${crypto.randomUUID().replaceAll("-", "")}`;
		const admin = new pg.Pool({ connectionString });
		await admin.query(`CREATE SCHEMA ${schema}`);
		const pool = new pg.Pool({
			connectionString,
			options: `-c search_path=${schema}`,
		});
		const runtime = ManagedRuntime.make(
			CloudProviderConnectionsLive.pipe(
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
						"../../drizzle/migrations/0037_cloud_provider_connections.sql",
						import.meta.url,
					),
					"utf8",
				),
			);
			const store = await runtime.runPromise(CloudProviderConnections);
			const record = (
				id: string,
				accountId = "alice",
			): ProviderConnectionRecord => ({
				connectionId: id,
				accountId,
				providerId: "boxd",
				envelope: "encrypted-envelope",
				active: true,
				createdAt: 1,
			});
			await Promise.all(
				Array.from({ length: 8 }, (_, i) =>
					runtime.runPromise(store.save(record(`key-${i}`))),
				),
			);
			const rows = await runtime.runPromise(store.list("alice"));
			expect(rows).toHaveLength(8);
			expect(rows.filter((row) => row.active)).toHaveLength(1);
			const active = rows.find((row) => row.active);
			if (!active) throw new Error("Missing active connection");
			await runtime.runPromise(store.disconnect("bob", active.connectionId));
			expect(
				(await runtime.runPromise(store.list("alice"))).filter(
					(row) => row.active,
				),
			).toHaveLength(1);
			await expect(
				runtime.runPromise(store.save(record("key-0"))),
			).rejects.toMatchObject({
				code: "cloud_provider_connection_storage_unavailable",
			});
			expect(
				(await runtime.runPromise(store.list("alice"))).find(
					(row) => row.active,
				)?.connectionId,
			).toBe(active.connectionId);
			await runtime.runPromise(store.save(record("bob-key", "bob")));
			expect(await runtime.runPromise(store.list("bob"))).toEqual([
				record("bob-key", "bob"),
			]);
			await runtime.runPromise(store.disconnect("alice", active.connectionId));
			expect(
				(await runtime.runPromise(store.list("alice"))).filter(
					(row) => row.active,
				),
			).toHaveLength(0);
			expect(
				(
					await pool.query(
						"SELECT count(*)::int AS count FROM api_cloud_provider_connections",
					)
				).rows[0].count,
			).toBe(9);
		} finally {
			await runtime.dispose();
			await pool.end();
			await admin.query(`DROP SCHEMA ${schema} CASCADE`);
			await admin.end();
		}
	},
);
