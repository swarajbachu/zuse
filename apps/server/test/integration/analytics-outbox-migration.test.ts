import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";

import { Migration0042AnalyticsOutbox } from "../../src/persistence/migrations/0042_analytics_outbox.ts";

describe("analytics outbox migration", () => {
	it("creates a durable retry queue with a due-time index", async () => {
		const runtime = ManagedRuntime.make(sqliteLayer({ filename: ":memory:" }));
		try {
			const snapshot = await runtime.runPromise(
				Effect.gen(function* () {
					yield* Migration0042AnalyticsOutbox;
					const sql = yield* SqlClient.SqlClient;
					const columns = yield* sql<{ readonly name: string }>`
						PRAGMA table_info(analytics_outbox)
					`;
					const indexes = yield* sql<{ readonly name: string }>`
						SELECT name FROM sqlite_master
						WHERE type = 'index' AND name = 'idx_analytics_outbox_due'
					`;
					return { columns, indexes };
				}),
			);

			expect(snapshot.columns.map(({ name }) => name)).toEqual([
				"id",
				"distinct_id",
				"event",
				"properties_json",
				"captured_at",
				"attempts",
				"next_attempt_at",
			]);
			expect(snapshot.indexes).toEqual([{ name: "idx_analytics_outbox_due" }]);
		} finally {
			await runtime.dispose();
		}
	});
});
