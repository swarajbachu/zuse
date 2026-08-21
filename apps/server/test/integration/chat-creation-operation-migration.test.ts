import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import { Migration0044ChatCreationOperations } from "../../src/persistence/migrations/0044_chat_creation_operations.ts";
import { Migration0049ChatCreationStartupReady } from "../../src/persistence/migrations/0049_chat_creation_startup_ready.ts";
import { Migration0050DurableChatCreation } from "../../src/persistence/migrations/0050_durable_chat_creation.ts";
import { Migration0051LegacyChatCreationPhaseRepair } from "../../src/persistence/migrations/0051_legacy_chat_creation_phase_repair.ts";

describe("chat creation operation migration", () => {
	it("persists one resolved workspace per client operation", async () => {
		const runtime = ManagedRuntime.make(sqliteLayer({ filename: ":memory:" }));
		try {
			await runtime.runPromise(Migration0044ChatCreationOperations);
			await runtime.runPromise(Migration0049ChatCreationStartupReady);
			await runtime.runPromise(Migration0050DurableChatCreation);
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
						readonly startup_ready: number;
					}>`
						SELECT operation_id, worktree_id, status, startup_ready
						FROM chat_creation_operations
					`;
				}),
			);
			expect(rows).toEqual([
				{
					operation_id: "op-1",
					worktree_id: "worktree-1",
					status: "creating_chat",
					startup_ready: 1,
				},
			]);
		} finally {
			await runtime.dispose();
		}
	});

	it("maps legacy creation statuses to explicit resumable phases", async () => {
		const runtime = ManagedRuntime.make(sqliteLayer({ filename: ":memory:" }));
		try {
			await runtime.runPromise(Migration0044ChatCreationOperations);
			await runtime.runPromise(Migration0049ChatCreationStartupReady);
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					for (const [index, status] of [
						"pending",
						"creating_workspace",
						"creating_chat",
						"succeeded",
						"failed",
					].entries()) {
						yield* sql`
							INSERT INTO chat_creation_operations (
								operation_id, chat_id, initial_session_id, project_id,
								provider_id, model, runtime_mode, permission_mode,
								workspace_policy, status, error, created_at, updated_at
							) VALUES (
								${`op-${index}`}, ${`chat-${index}`}, ${`session-${index}`}, 'project-1',
								'codex', 'gpt-5.4', 'approval-required', 'default',
								'main', ${status}, ${status === "failed" ? "legacy failure" : null}, 'now', 'now'
							)
						`;
					}
				}),
			);
			await runtime.runPromise(Migration0050DurableChatCreation);
			const rows = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					return yield* sql<{
						readonly phase: string;
						readonly failure_stage: string | null;
						readonly retryable: number;
					}>`
						SELECT phase, failure_stage, retryable
						FROM chat_creation_operations ORDER BY operation_id
					`;
				}),
			);
			expect(rows).toEqual([
				{ phase: "persisted", failure_stage: null, retryable: 1 },
				{ phase: "creating_workspace", failure_stage: null, retryable: 1 },
				{ phase: "starting_agent", failure_stage: null, retryable: 1 },
				{ phase: "running", failure_stage: null, retryable: 1 },
				{
					phase: "failed",
					failure_stage: "legacy_unknown",
					retryable: 0,
				},
			]);
		} finally {
			await runtime.dispose();
		}
	});

	it("atomically claims one terminal PR notification", async () => {
		const runtime = ManagedRuntime.make(sqliteLayer({ filename: ":memory:" }));
		try {
			await runtime.runPromise(Migration0044ChatCreationOperations);
			await runtime.runPromise(Migration0049ChatCreationStartupReady);
			await runtime.runPromise(Migration0050DurableChatCreation);
			const claims = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const claim = () =>
						sql<{ readonly identity: string }>`
							INSERT INTO git_pr_notification_claims (identity, claimed_at)
							VALUES ('pr-1:merged', 'now')
							ON CONFLICT(identity) DO NOTHING
							RETURNING identity
						`;
					return [yield* claim(), yield* claim()];
				}),
			);
			expect(claims.map((claim) => claim.length)).toEqual([1, 0]);
		} finally {
			await runtime.dispose();
		}
	});

	it("repairs completed legacy operations written after the durable migration", async () => {
		const runtime = ManagedRuntime.make(sqliteLayer({ filename: ":memory:" }));
		try {
			await runtime.runPromise(Migration0044ChatCreationOperations);
			await runtime.runPromise(Migration0049ChatCreationStartupReady);
			await runtime.runPromise(Migration0050DurableChatCreation);
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
						INSERT INTO chat_creation_operations (
							operation_id, chat_id, initial_session_id, project_id,
							provider_id, model, runtime_mode, permission_mode,
							workspace_policy, status, created_at, updated_at
						) VALUES (
							'legacy-after-0050', 'chat-legacy', 'session-legacy', 'project-1',
							'opencode', 'opencode/model', 'approval-required', 'default',
							'main', 'succeeded', 'now', 'now'
						)
					`;
				}),
			);

			await runtime.runPromise(Migration0051LegacyChatCreationPhaseRepair);
			const rows = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					return yield* sql<{
						readonly status: string;
						readonly phase: string;
					}>`
						SELECT status, phase FROM chat_creation_operations
						WHERE operation_id = 'legacy-after-0050'
					`;
				}),
			);

			expect(rows).toEqual([{ status: "succeeded", phase: "running" }]);
		} finally {
			await runtime.dispose();
		}
	});
});
