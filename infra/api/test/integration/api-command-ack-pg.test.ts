import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Pool } from "pg";
import { expect, test } from "vitest";
import {
	CloudWorkspaceStore,
	CloudWorkspaceStorePg,
} from "../../src/cloud-workspace-store.ts";

// Opt-in real PostgreSQL regression: the memory store cannot detect untyped
// nullable parameters in an IS NOT NULL expression. Uses a connection-local table.
const url = process.env.ZUSE_TEST_POSTGRES_URL;
test.skipIf(!url)(
	"acknowledges deterministic commands with nullable PostgreSQL guard parameters",
	async () => {
		const db = PgClient.layerFrom(
			PgClient.fromPool({
				acquire: Effect.acquireRelease(
					Effect.sync(() => new Pool({ connectionString: url, max: 1 })),
					(pool) => Effect.promise(() => pool.end()),
				),
			}),
		);
		const runtime = ManagedRuntime.make(
			CloudWorkspaceStorePg.pipe(Layer.provideMerge(db)),
		);
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const store = yield* CloudWorkspaceStore;
					yield* sql`CREATE TEMP TABLE api_cloud_workspace_api_messages (workspace_id text, message_id text, role text, status text, turn_id text, delivered_at bigint)`;
					yield* sql`INSERT INTO api_cloud_workspace_api_messages VALUES ('w', 'm', 'user', 'pending', 'provisional', NULL)`;
					expect(
						yield* store.ackApiCommand("w", "m", "actual", undefined, 100),
					).toBe(false);
					expect(
						yield* store.ackApiCommand("w", "m", "actual", "provisional", 123),
					).toBe(true);
					expect(
						yield* store.ackApiCommand("w", "m", "actual", "provisional", 999),
					).toBe(true);
					const rows =
						yield* sql`SELECT status, turn_id, delivered_at FROM api_cloud_workspace_api_messages`;
					expect(rows[0]?.status).toBe("delivered");
					expect(rows[0]?.turn_id).toBe("actual");
					expect(Number(rows[0]?.delivered_at)).toBe(123);
				}),
			);
		} finally {
			await runtime.dispose();
		}
	},
);
