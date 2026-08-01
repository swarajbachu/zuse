import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import { Migration0044ChatCreationOperations } from "../../src/persistence/migrations/0044_chat_creation_operations.ts";

describe("chat creation operation migration", () => {
	it("persists one resolved workspace per client operation", async () => {
		const runtime = ManagedRuntime.make(sqliteLayer({ filename: ":memory:" }));
		try {
			await runtime.runPromise(Migration0044ChatCreationOperations);
			const rows = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
						INSERT INTO chat_creation_operations (
							operation_id, chat_id, initial_session_id, project_id,
							provider_id, model, runtime_mode, permission_mode,
							workspace_policy, worktree_id, status, created_at, updated_at
						) VALUES (
							'op-1', 'chat-1', 'session-1', 'project-1',
							'codex', 'gpt-5.4', 'approval-required', 'default',
							'fresh', 'worktree-1', 'creating_chat', 'now', 'now'
						)
					`;
					yield* sql`
						INSERT INTO chat_creation_operations (
							operation_id, chat_id, initial_session_id, project_id,
							provider_id, model, runtime_mode, permission_mode,
							workspace_policy, status, created_at, updated_at
						) VALUES (
							'op-1', 'chat-1', 'session-1', 'project-1',
							'codex', 'gpt-5.4', 'approval-required', 'default',
							'fresh', 'pending', 'later', 'later'
						)
						ON CONFLICT(operation_id) DO NOTHING
					`;
					return yield* sql<{
						readonly operation_id: string;
						readonly worktree_id: string | null;
						readonly status: string;
					}>`
						SELECT operation_id, worktree_id, status
						FROM chat_creation_operations
					`;
				}),
			);
			expect(rows).toEqual([
				{
					operation_id: "op-1",
					worktree_id: "worktree-1",
					status: "creating_chat",
				},
			]);
		} finally {
			await runtime.dispose();
		}
	});
});
