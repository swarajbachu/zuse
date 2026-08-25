import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatId, ComposerInput, SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import {
	chatStartupCommandId,
	persistChatStartupIntent,
	updateQueuedMessageWithStartupHandoff,
} from "../../src/conversation/core/chat-startup-intent.ts";
import { QueueTransactionService } from "../../src/conversation/services/conversation-services.ts";
import {
	FIXTURE_PROJECT_ID,
	FIXTURE_PROJECT_PATH,
	makeConversationFixtureRuntime,
	TestConversation,
} from "../support/conversation-services-fixture-harness.ts";

const startupInput = ComposerInput.make({
	text: "finish even if the app closes",
	attachments: [],
	fileRefs: [],
	skillRefs: [],
	annotations: [],
});

describe("durable chat startup intent", () => {
	it("deduplicates a retry after a lost success response", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-chat-startup-"));
		const runtime = makeConversationFixtureRuntime(
			join(directory, "fixture.sqlite"),
			[],
		);
		const run = <A>(
			effect: Effect.Effect<
				A,
				unknown,
				TestConversation | QueueTransactionService | SqlClient.SqlClient
			>,
		): Promise<A> =>
			runtime.runPromise(effect as Effect.Effect<A, unknown, never>);

		try {
			const operationId = "operation-lost-response";
			const chatId = ChatId.make("chat-lost-response");
			const sessionId = SessionId.make("session-lost-response");
			const queueId = "queue-lost-response";

			await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const now = new Date().toISOString();
					yield* sql`
						INSERT INTO projects (id, path, name, created_at, updated_at)
						VALUES (${FIXTURE_PROJECT_ID}, ${FIXTURE_PROJECT_PATH}, ${"Fixture"}, ${now}, ${now})
					`;
					yield* sql`
						INSERT INTO chat_creation_operations (
							operation_id, chat_id, initial_session_id, project_id,
							provider_id, model, title, runtime_mode, permission_mode,
							tool_search, prompt, startup_input_json, startup_queue_id,
							workspace_policy, worktree_id, status, error, created_at, updated_at
						) VALUES (
							${operationId}, ${chatId}, ${sessionId}, ${FIXTURE_PROJECT_ID},
							${"claude"}, ${"fixture-model"}, ${"Durable startup"},
							${"approval-required"}, ${"default"}, 0, ${startupInput.text},
							${JSON.stringify(startupInput)}, ${queueId}, ${"main"}, NULL,
							${"creating_chat"}, NULL, ${now}, ${now}
						)
					`;
				}),
			);

			await run(
				Effect.flatMap(TestConversation, (service) =>
					service.createChat({
						chatId,
						initialSessionId: sessionId,
						projectId: FIXTURE_PROJECT_ID,
						providerId: "claude",
						model: "fixture-model",
					}),
				),
			);

			const firstAccepted = await run(
				Effect.gen(function* () {
					const queue = yield* QueueTransactionService;
					const sql = yield* SqlClient.SqlClient;
					return yield* persistChatStartupIntent(queue, sql, {
						operationId,
						sessionId,
						input: startupInput,
						queueId,
						ready: true,
					});
				}),
			);
			// Model an RPC response disappearing after both durable commits. The same
			// operation is replayed on reconnect and must observe the receipt only.
			const retriedAccepted = await run(
				Effect.gen(function* () {
					const queue = yield* QueueTransactionService;
					const sql = yield* SqlClient.SqlClient;
					return yield* persistChatStartupIntent(queue, sql, {
						operationId,
						sessionId,
						input: startupInput,
						queueId,
						ready: true,
					});
				}),
			);

			const evidence = await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const queued = yield* sql<{
						readonly id: string;
						readonly input_json: string;
						readonly ready: number;
					}>`
						SELECT id, input_json, ready FROM queued_messages
						WHERE session_id = ${sessionId}
					`;
					const events = yield* sql<{ readonly count: number }>`
						SELECT COUNT(*) AS count FROM events
						WHERE stream_id = ${sessionId} AND type = 'QueuedTurnEnqueued'
					`;
					const receipts = yield* sql<{ readonly stream_id: string }>`
						SELECT stream_id FROM command_receipts
						WHERE command_id = ${chatStartupCommandId(operationId)}
					`;
					const operation = yield* sql<{ readonly status: string }>`
						SELECT status FROM chat_creation_operations
						WHERE operation_id = ${operationId}
					`;
					return { queued, events, receipts, operation };
				}),
			);

			expect(firstAccepted).toBe(true);
			expect(retriedAccepted).toBe(false);
			expect(evidence.queued).toHaveLength(1);
			expect(evidence.queued[0]).toMatchObject({ id: queueId, ready: 1 });
			expect(JSON.parse(evidence.queued[0]?.input_json ?? "null")).toEqual(
				startupInput,
			);
			expect(evidence.events[0]?.count).toBe(1);
			expect(evidence.receipts).toEqual([{ stream_id: sessionId }]);
			expect(evidence.operation).toEqual([{ status: "succeeded" }]);

			// The runnable bit was part of the atomic acceptance above. The handler's
			// post-commit wake uses the same stable command id, while runtime recovery
			// scans every ready row after a process restart.
		} finally {
			await runtime.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("holds a plain startup prompt while generated context is still pending", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-chat-startup-held-"));
		const runtime = makeConversationFixtureRuntime(
			join(directory, "fixture.sqlite"),
			[],
		);
		const run = <A>(
			effect: Effect.Effect<
				A,
				unknown,
				TestConversation | QueueTransactionService | SqlClient.SqlClient
			>,
		): Promise<A> =>
			runtime.runPromise(effect as Effect.Effect<A, unknown, never>);

		try {
			const operationId = "operation-held-context";
			const chatId = ChatId.make("chat-held-context");
			const sessionId = SessionId.make("session-held-context");
			const queueId = "queue-held-context";
			await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const now = new Date().toISOString();
					yield* sql`
						INSERT INTO projects (id, path, name, created_at, updated_at)
						VALUES (${FIXTURE_PROJECT_ID}, ${FIXTURE_PROJECT_PATH}, ${"Fixture"}, ${now}, ${now})
					`;
					yield* sql`
						INSERT INTO chat_creation_operations (
							operation_id, chat_id, initial_session_id, project_id,
							provider_id, model, runtime_mode, permission_mode,
							startup_input_json, startup_queue_id, startup_ready,
							workspace_policy, status, created_at, updated_at
						) VALUES (
							${operationId}, ${chatId}, ${sessionId}, ${FIXTURE_PROJECT_ID},
							${"claude"}, ${"fixture-model"}, ${"approval-required"}, ${"default"},
							${JSON.stringify(startupInput)}, ${queueId}, 0,
							${"main"}, ${"creating_chat"}, ${now}, ${now}
						)
					`;
				}),
			);
			await run(
				Effect.flatMap(TestConversation, (service) =>
					service.createChat({
						chatId,
						initialSessionId: sessionId,
						projectId: FIXTURE_PROJECT_ID,
						providerId: "claude",
						model: "fixture-model",
					}),
				),
			);

			await run(
				Effect.gen(function* () {
					const queue = yield* QueueTransactionService;
					const sql = yield* SqlClient.SqlClient;
					yield* persistChatStartupIntent(queue, sql, {
						operationId,
						sessionId,
						input: startupInput,
						queueId,
						ready: false,
					});
				}),
			);
			const held = await run(
				Effect.flatMap(TestConversation, (service) =>
					service.listQueuedMessages(sessionId),
				),
			);
			expect(held.items).toHaveLength(1);
			expect(held.items[0]?.ready).toBe(false);
		} finally {
			await runtime.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("finalizes startup input that arrives before the held row is inserted", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-chat-startup-race-"));
		const runtime = makeConversationFixtureRuntime(
			join(directory, "fixture.sqlite"),
			[],
		);
		const run = <A>(
			effect: Effect.Effect<
				A,
				unknown,
				TestConversation | QueueTransactionService | SqlClient.SqlClient
			>,
		): Promise<A> =>
			runtime.runPromise(effect as Effect.Effect<A, unknown, never>);

		try {
			const operationId = "operation-early-finalization";
			const chatId = ChatId.make("chat-early-finalization");
			const sessionId = SessionId.make("session-early-finalization");
			const queueId = "queue-early-finalization";
			const finalizedInput = ComposerInput.make({
				...startupInput,
				attachments: [
					{
						id: "session-early-finalization-attachment",
						mimeType: "image/png",
						originalName: "startup.png",
					},
				],
			});
			await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const now = new Date().toISOString();
					yield* sql`
						ALTER TABLE chat_creation_operations
						ADD COLUMN phase TEXT NOT NULL DEFAULT 'persisted'
					`;
					yield* sql`
						INSERT INTO projects (id, path, name, created_at, updated_at)
						VALUES (${FIXTURE_PROJECT_ID}, ${FIXTURE_PROJECT_PATH}, ${"Fixture"}, ${now}, ${now})
					`;
					yield* sql`
						INSERT INTO chat_creation_operations (
							operation_id, chat_id, initial_session_id, project_id,
							provider_id, model, runtime_mode, permission_mode,
							startup_input_json, startup_queue_id, startup_ready,
							workspace_policy, status, phase, created_at, updated_at
						) VALUES (
							${operationId}, ${chatId}, ${sessionId}, ${FIXTURE_PROJECT_ID},
							${"claude"}, ${"fixture-model"}, ${"approval-required"}, ${"default"},
							${JSON.stringify(startupInput)}, ${queueId}, 0,
							${"main"}, ${"creating_chat"}, ${"starting_agent"}, ${now}, ${now}
						)
					`;
				}),
			);
			await run(
				Effect.flatMap(TestConversation, (service) =>
					service.createChat({
						chatId,
						initialSessionId: sessionId,
						projectId: FIXTURE_PROJECT_ID,
						providerId: "claude",
						model: "fixture-model",
						background: true,
					}),
				),
			);

			const updated = await run(
				Effect.gen(function* () {
					const service = yield* TestConversation;
					const queueTransaction = yield* QueueTransactionService;
					const sql = yield* SqlClient.SqlClient;
					return yield* updateQueuedMessageWithStartupHandoff(
						service,
						queueTransaction,
						sql,
						"queue-update-early-finalization",
						sessionId,
						queueId,
						finalizedInput,
					);
				}),
			);
			const operation = await run(
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql<{ readonly status: string }>`
						SELECT status FROM chat_creation_operations
						WHERE operation_id = ${operationId}
					`,
				),
			);

			expect(updated.ready).toBe(true);
			expect(updated.input).toEqual(finalizedInput);
			expect(operation).toEqual([{ status: "succeeded" }]);
		} finally {
			await runtime.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
