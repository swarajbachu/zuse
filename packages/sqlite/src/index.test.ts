import { Effect, ManagedRuntime, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";

import { layer } from "./index.js";

describe("node sqlite client", () => {
	test("executes queries, transactions, and boolean bindings", async () => {
		const runtime = ManagedRuntime.make(layer({ filename: ":memory:" }));
		try {
			const rows = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`CREATE TABLE checks (id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL)`;
					yield* sql.withTransaction(
						sql`INSERT INTO checks (enabled) VALUES (${true})`,
					);
					return yield* sql<{ readonly enabled: number }>`
						SELECT enabled FROM checks
					`;
				}),
			);

			expect(rows).toEqual([{ enabled: 1 }]);
		} finally {
			await runtime.dispose();
		}
	});

	test("streams query rows through the standard SqlClient API", async () => {
		const runtime = ManagedRuntime.make(layer({ filename: ":memory:" }));
		try {
			const rows = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`CREATE TABLE values_table (value INTEGER NOT NULL)`;
					yield* sql`INSERT INTO values_table (value) VALUES (1), (2), (3)`;
					return yield* Stream.runCollect(
						sql<{ readonly value: number }>`
							SELECT value FROM values_table ORDER BY value
						`.stream,
					);
				}),
			);

			expect([...rows]).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
		} finally {
			await runtime.dispose();
		}
	});
});
