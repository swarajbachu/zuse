import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";

import { Migration0053CloudCommandReceipts } from "../../src/persistence/migrations/0053_cloud_command_receipts.ts";

describe("cloud command receipt migration", () => {
	it("adds v3 identity fields without invalidating legacy receipts", async () => {
		const runtime = ManagedRuntime.make(sqliteLayer({ filename: ":memory:" }));
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`CREATE TABLE command_receipts (
						command_id TEXT PRIMARY KEY,
						stream_kind TEXT NOT NULL,
						stream_id TEXT NOT NULL,
						stream_version INTEGER NOT NULL,
						event_ids_json TEXT NOT NULL,
						result_json TEXT,
						created_at TEXT NOT NULL
					)`;
					yield* sql`INSERT INTO command_receipts VALUES
						('legacy-command', 'session', 'session-1', 1, '[]', NULL, 'now')`;
				}),
			);

			await runtime.runPromise(Migration0053CloudCommandReceipts);

			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const columns = yield* sql<{ readonly name: string }>`
						SELECT name FROM pragma_table_info('command_receipts')
						WHERE name IN ('fingerprint', 'command_kind', 'schema_version', 'storage_incarnation_id')
						ORDER BY name
					`;
					const rows = yield* sql<{
						readonly command_id: string;
						readonly fingerprint: string | null;
					}>`SELECT command_id, fingerprint FROM command_receipts`;
					return { columns, rows };
				}),
			);

			expect(result.columns.map((column) => column.name)).toEqual([
				"command_kind",
				"fingerprint",
				"schema_version",
				"storage_incarnation_id",
			]);
			expect(result.rows).toEqual([
				{ command_id: "legacy-command", fingerprint: null },
			]);
		} finally {
			await runtime.dispose();
		}
	});
});
