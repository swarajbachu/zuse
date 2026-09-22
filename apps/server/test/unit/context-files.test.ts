import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, FileSystem, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import { resolveSessionCwd } from "../../src/context/context-files.ts";

describe("startup attachment workspace", () => {
	it("waits for a reserved worktree and never writes into the main checkout", async () => {
		const runtime = ManagedRuntime.make(sqliteLayer({ filename: ":memory:" }));
		const fs = FileSystem.makeNoop({ exists: () => Effect.succeed(true) });
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`CREATE TABLE sessions (id TEXT, project_id TEXT, chat_id TEXT, worktree_id TEXT)`;
					yield* sql`CREATE TABLE chats (id TEXT, archived_worktree_json TEXT)`;
					yield* sql`CREATE TABLE projects (id TEXT, path TEXT)`;
					yield* sql`CREATE TABLE worktrees (id TEXT, path TEXT)`;
					yield* sql`CREATE TABLE chat_creation_operations (initial_session_id TEXT, workspace_policy TEXT, worktree_id TEXT, phase TEXT)`;
					yield* sql`INSERT INTO projects VALUES ('project', '/main')`;
					yield* sql`INSERT INTO chats VALUES ('chat', NULL)`;
					yield* sql`INSERT INTO sessions VALUES ('session', 'project', 'chat', NULL)`;
					expect(yield* resolveSessionCwd(sql, fs, "session")).toBe("/main");
					yield* sql`INSERT INTO chat_creation_operations VALUES ('session', 'fresh', 'worktree', 'creating_workspace')`;
					expect(
						yield* resolveSessionCwd(sql, fs, "session", "/main"),
					).toBeNull();
					yield* sql`INSERT INTO worktrees VALUES ('worktree', '/worktree')`;
					expect(yield* resolveSessionCwd(sql, fs, "session", "/main")).toBe(
						"/worktree",
					);
					const missingFs = FileSystem.makeNoop({
						exists: () => Effect.succeed(false),
					});
					expect(
						yield* resolveSessionCwd(sql, missingFs, "session", "/main"),
					).toBeNull();
					yield* sql`UPDATE sessions SET worktree_id = 'worktree'`;
					expect(yield* resolveSessionCwd(sql, fs, "session", "/main")).toBe(
						"/worktree",
					);
					yield* sql`DELETE FROM worktrees`;
					expect(
						yield* resolveSessionCwd(sql, fs, "session", "/main"),
					).toBeNull();
				}),
			);
		} finally {
			await runtime.dispose();
		}
	});
});
