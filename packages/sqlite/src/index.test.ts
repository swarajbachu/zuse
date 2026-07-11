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

	test("enforces foreign keys and rolls failed transactions back", async () => {
		const runtime = ManagedRuntime.make(layer({ filename: ":memory:" }));
		try {
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`CREATE TABLE parents (id INTEGER PRIMARY KEY)`;
					yield* sql`CREATE TABLE children (
						id INTEGER PRIMARY KEY,
						parent_id INTEGER NOT NULL REFERENCES parents(id)
					)`;
					const foreignKeyRejected = yield* sql`
						INSERT INTO children (id, parent_id) VALUES (1, 999)
					`.pipe(Effect.flip, Effect.as(true));
					yield* sql
						.withTransaction(
							Effect.gen(function* () {
								yield* sql`INSERT INTO parents (id) VALUES (1)`;
								return yield* Effect.fail("rollback");
							}),
						)
						.pipe(Effect.catch(() => Effect.void));
					const parents = yield* sql<{ readonly count: number }>`
						SELECT COUNT(*) AS count FROM parents
					`;
					return { foreignKeyRejected, parents };
				}),
			);

			expect(result.foreignKeyRejected).toBe(true);
			expect(result.parents).toEqual([{ count: 0 }]);
		} finally {
			await runtime.dispose();
		}
	});

	test("round-trips blobs and normalized date parameters", async () => {
		const runtime = ManagedRuntime.make(layer({ filename: ":memory:" }));
		try {
			const blob = Uint8Array.from([0, 1, 127, 255]);
			const date = new Date("2026-07-11T12:34:56.000Z");
			const rows = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`CREATE TABLE payloads (data BLOB, created_at TEXT)`;
					yield* sql`
						INSERT INTO payloads (data, created_at) VALUES (${blob}, ${date})
					`;
					return yield* sql<{
						readonly data: Uint8Array;
						readonly created_at: string;
					}>`SELECT data, created_at FROM payloads`;
				}),
			);

			expect(rows).toHaveLength(1);
			expect(rows[0]?.data === undefined ? [] : [...rows[0].data]).toEqual([
				...blob,
			]);
			expect(rows[0]?.created_at).toBe(date.toISOString());
		} finally {
			await runtime.dispose();
		}
	});

	test("serializes concurrent writes without losing rows", async () => {
		const runtime = ManagedRuntime.make(layer({ filename: ":memory:" }));
		try {
			const rows = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`CREATE TABLE writes (id INTEGER PRIMARY KEY)`;
					yield* Effect.forEach(
						Array.from({ length: 100 }, (_, id) => id),
						(id) => sql`INSERT INTO writes (id) VALUES (${id})`,
						{ concurrency: "unbounded", discard: true },
					);
					return yield* sql<{ readonly count: number }>`
						SELECT COUNT(*) AS count FROM writes
					`;
				}),
			);

			expect(rows).toEqual([{ count: 100 }]);
		} finally {
			await runtime.dispose();
		}
	});
});
