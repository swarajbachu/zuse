import { readFile } from "node:fs/promises";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Pool } from "pg";
import { expect, test } from "vitest";
import {
	ReviewLifecycleStore,
	ReviewLifecycleStorePg,
	type ReviewNativeConnection,
} from "../../src/review-lifecycle-store.ts";

const url = process.env.ZUSE_TEST_POSTGRES_URL;
test.skipIf(!url)(
	"native identity serializes duplicate connections across actors and preserves billing owner",
	async () => {
		const schema = `review_native_${crypto.randomUUID().replaceAll("-", "")}`;
		const admin = new Pool({ connectionString: url });
		await admin.query(`CREATE SCHEMA ${schema}`);
		const pool = new Pool({
			connectionString: url,
			options: `-c search_path=${schema}`,
		});
		const layer = ReviewLifecycleStorePg.pipe(
			Layer.provide(
				PgClient.layerFrom(
					PgClient.fromPool({ acquire: Effect.succeed(pool) }),
				),
			),
		);
		const runtime = ManagedRuntime.make(layer);
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
			const store = await runtime.runPromise(ReviewLifecycleStore);
			const c = (id: string, actor: string): ReviewNativeConnection => ({
				id,
				ownerActorId: actor,
				ownerId: `payer-${actor}`,
				label: "Claude",
				agentProvider: "claude",
				sandboxProvider: "e2b",
				size: "small",
				models: ["model"],
				providerSandboxId: "sandbox",
				state: "ready",
				providerIdentity: "claude:shared-verified-identity",
				createdAtMs: 1,
				updatedAtMs: 1,
			});
			await store.saveConnection(c("one", "actor-one"));
			await store.saveConnection(c("two", "actor-two"));
			const claims = await Promise.all([
				store.claimConnection("one", "actor-one", "lease-one", 10),
				store.claimConnection("two", "actor-two", "lease-two", 10),
			]);
			expect(claims.filter(Boolean)).toHaveLength(1);
			await store.releaseConnection("one", "lease-one");
			await store.releaseConnection("two", "lease-two");
			expect(
				await store.claimConnection("two", "actor-two", "new-lease", 11),
			).toBe(true);
			await store.saveActivity({
				id: "login",
				connectionId: "one",
				ownerId: "original-payer",
				provider: "e2b",
				providerSandboxId: "sandbox",
				startedAtMs: 1,
				stoppedAtMs: null,
				deadlineMs: 1000,
				maximumCostMicros: 25,
				state: "running",
			});
			await store.saveActivity({
				id: "login",
				connectionId: "one",
				ownerId: "different-payer",
				provider: "e2b",
				providerSandboxId: "sandbox",
				startedAtMs: 2,
				stoppedAtMs: 100,
				deadlineMs: 2000,
				maximumCostMicros: 900,
				state: "stopped",
			});
			expect((await store.getActivity("login"))?.ownerId).toBe(
				"original-payer",
			);
			expect((await store.getActivity("login"))?.startedAtMs).toBe(1);
			expect((await store.getActivity("login"))?.stoppedAtMs).toBe(100);
			await store.revokeConnection("one", 200);
			await store.saveConnection(c("one", "actor-one"));
			expect((await store.getConnection("one"))?.state).toBe("revoked");
			expect(
				await store.claimConnection("one", "actor-one", "revoked-lease", 300),
			).toBe(false);
		} finally {
			await runtime.dispose();
			await pool.end();
			await admin.query(`DROP SCHEMA ${schema} CASCADE`);
			await admin.end();
		}
	},
);
