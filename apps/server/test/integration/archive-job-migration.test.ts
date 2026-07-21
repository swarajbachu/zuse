import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import * as Migrator from "effect/unstable/sql/Migrator";
import { describe, expect, it } from "vitest";

import { Migration0041ChatArchiveJobs } from "../../src/persistence/migrations/0041_chat_archive_jobs.ts";

describe("archive job migration", () => {
	it("runs after an existing migration with id 40", async () => {
		const runtime = ManagedRuntime.make(sqliteLayer({ filename: ":memory:" }));
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
						CREATE TABLE effect_sql_migrations (
							migration_id INTEGER PRIMARY KEY NOT NULL,
							created_at DATETIME NOT NULL DEFAULT current_timestamp,
							name VARCHAR(255) NOT NULL
						)
					`;
					yield* sql`
						INSERT INTO effect_sql_migrations (migration_id, name)
						VALUES (40, 'blocked_nearby_devices')
					`;
					yield* sql`CREATE TABLE worktrees (id TEXT PRIMARY KEY)`;
					yield* sql`CREATE TABLE chats (id TEXT PRIMARY KEY, worktree_id TEXT)`;
					yield* sql`
						CREATE TABLE sessions (
							id TEXT PRIMARY KEY,
							chat_id TEXT,
							worktree_id TEXT,
							archived_at INTEGER
						)
					`;
					yield* sql`CREATE TABLE attachments (id TEXT PRIMARY KEY, abs_path TEXT)`;
				}),
			);

			await runtime.runPromise(
				Migrator.make({})({
					loader: Migrator.fromRecord({
						"0041_chat_archive_jobs": Migration0041ChatArchiveJobs,
					}),
				}),
			);

			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const tables = yield* sql<{ readonly name: string }>`
					SELECT name FROM sqlite_master
					WHERE type = 'table' AND name = 'chat_archive_jobs'
				`;
					const migrations = yield* sql<{
						readonly migration_id: number;
						readonly name: string;
					}>`
					SELECT migration_id, name FROM effect_sql_migrations
					ORDER BY migration_id
				`;
					const worktreeColumns = yield* sql<{
						readonly name: string;
					}>`PRAGMA table_info(worktrees)`;
					return { tables, migrations, worktreeColumns };
				}),
			);

			expect(result.tables).toEqual([{ name: "chat_archive_jobs" }]);
			expect(result.migrations).toEqual([
				{ migration_id: 40, name: "blocked_nearby_devices" },
				{ migration_id: 41, name: "chat_archive_jobs" },
			]);
			expect(result.worktreeColumns.map(({ name }) => name)).toContain(
				"archive_state",
			);
		} finally {
			await runtime.dispose();
		}
	});
});
