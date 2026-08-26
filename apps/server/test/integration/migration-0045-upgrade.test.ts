import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import {
	MigrationsLive,
	MigrationsThrough0045Live,
} from "../../src/persistence/migrations.ts";

const migratedRuntime = (
	filename: string,
	migrations: typeof MigrationsLive,
) => {
	const sqlite = sqliteLayer({ filename, disableWAL: true });
	return ManagedRuntime.make(
		Layer.merge(sqlite, migrations.pipe(Layer.provide(sqlite))),
	);
};

describe("migration 0045 upgrade compatibility", () => {
	it("preserves projects, chats, and sessions and accepts a new chat", async () => {
		let stage = "initialize migration-0045 database";
		const directory = mkdtempSync(join(tmpdir(), "zuse-migration-0045-"));
		const filename = join(directory, "zuse.sqlite");
		const legacyRuntime = migratedRuntime(filename, MigrationsThrough0045Live);

		try {
			stage = "insert migration-0045 rows";
			await legacyRuntime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const createdAt = "2026-01-01T00:00:00.000Z";
					const duplicateCreatedAt = "2026-01-01T00:00:01.000Z";
					stage = "insert the legacy project";
					yield* sql`
						INSERT INTO projects (id, path, name, created_at, updated_at)
						VALUES ('project-legacy', '/tmp/project-legacy', 'Legacy project',
							${createdAt}, ${createdAt})
					`;
					yield* sql`
						INSERT INTO projects (id, path, name, created_at, updated_at)
						VALUES ('project-duplicate', '/tmp/project-legacy', 'Duplicate project',
							${duplicateCreatedAt}, ${duplicateCreatedAt})
					`;
					stage = "insert the legacy chat";
					yield* sql`
						INSERT INTO chats
							(id, project_id, worktree_id, title, active_session_id,
							 origin_session_id, archived_at, archived_worktree_json,
							 last_message_at, last_read_at, created_at, updated_at)
						VALUES ('chat-legacy', 'project-legacy', NULL, 'Legacy chat',
							NULL, NULL, NULL, NULL, ${createdAt}, ${createdAt},
							${createdAt}, ${createdAt})
					`;
					stage = "insert the legacy session";
					yield* sql`
						INSERT INTO sessions
							(id, project_id, title, provider_id, model, status, chat_id,
							 created_at, updated_at)
						VALUES ('session-legacy', 'project-legacy', 'Legacy chat', 'codex',
							'gpt-5', 'idle', 'chat-legacy', ${createdAt}, ${createdAt})
					`;
					stage = "link the legacy chat session";
					yield* sql`
						UPDATE chats SET active_session_id = 'session-legacy'
						WHERE id = 'chat-legacy'
					`;
					yield* sql`
						INSERT INTO chats
							(id, project_id, worktree_id, title, active_session_id,
							 origin_session_id, archived_at, archived_worktree_json,
							 last_message_at, last_read_at, created_at, updated_at)
						VALUES ('chat-duplicate', 'project-duplicate', NULL, 'Duplicate chat',
							NULL, NULL, NULL, NULL, ${createdAt}, ${createdAt},
							${createdAt}, ${createdAt})
					`;
					yield* sql`
						INSERT INTO sessions
							(id, project_id, title, provider_id, model, status, chat_id,
							 created_at, updated_at)
						VALUES ('session-duplicate', 'project-duplicate', 'Duplicate chat',
							'codex', 'gpt-5', 'idle', 'chat-duplicate', ${createdAt}, ${createdAt})
					`;
				}),
			);
			await legacyRuntime.dispose();

			stage = "run current migrations";
			const currentRuntime = migratedRuntime(filename, MigrationsLive);
			try {
				stage = "verify upgraded rows";
				const result = await currentRuntime.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const integrity = yield* sql<{ readonly quick_check: string }>`
							PRAGMA quick_check
						`;
						const counts = yield* sql<{
							readonly projects: number;
							readonly chats: number;
							readonly sessions: number;
						}>`
							SELECT
								(SELECT COUNT(*) FROM projects) AS projects,
								(SELECT COUNT(*) FROM chats) AS chats,
								(SELECT COUNT(*) FROM sessions) AS sessions
						`;
						const createdAt = "2026-01-02T00:00:00.000Z";
						yield* sql`
							INSERT INTO chats
								(id, project_id, worktree_id, title, active_session_id,
								 origin_session_id, archived_at, archived_worktree_json,
								 last_message_at, last_read_at, created_at, updated_at)
							VALUES ('chat-new', 'project-legacy', NULL, 'New chat', NULL,
								NULL, NULL, NULL, NULL, ${createdAt}, ${createdAt}, ${createdAt})
						`;
						const newChats = yield* sql<{ readonly count: number }>`
							SELECT COUNT(*) AS count FROM chats WHERE id = 'chat-new'
						`;
						const projectReferences = yield* sql<{
							readonly project_id: string;
						}>`
							SELECT project_id FROM chats
							UNION
							SELECT project_id FROM sessions
							ORDER BY project_id
						`;
						const indexes = yield* sql<{
							readonly name: string;
							readonly unique: number;
						}>`PRAGMA index_list(projects)`;
						return { integrity, counts, newChats, projectReferences, indexes };
					}),
				);

				expect(result.integrity).toEqual([{ quick_check: "ok" }]);
				expect(result.counts).toEqual([{ projects: 1, chats: 2, sessions: 2 }]);
				expect(result.newChats).toEqual([{ count: 1 }]);
				expect(result.projectReferences).toEqual([
					{ project_id: "project-legacy" },
				]);
				expect(result.indexes).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							name: "idx_projects_path_unique",
							unique: 1,
						}),
					]),
				);
			} finally {
				await currentRuntime.dispose();
			}
		} catch (cause) {
			throw new Error(`Upgrade test failed while attempting to ${stage}.`, {
				cause,
			});
		} finally {
			await legacyRuntime.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
