import { ComposerInput, SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { describe, expect, it, vi } from "vitest";
import {
	chatStartupCommandId,
	decodeChatStartupIntent,
	persistChatStartupIntent,
} from "../../src/conversation/core/chat-startup-intent.ts";
import type { QueueTransactionServiceShape } from "../../src/conversation/services/conversation-services.ts";

const sessionId = SessionId.make("session-1");
const input = ComposerInput.make({
	text: "finish even if the app closes",
	attachments: [],
	fileRefs: [],
	skillRefs: [],
	annotations: [],
});

describe("chat startup intent", () => {
	it("requires the full stable identity before accepting startup work", () => {
		expect(
			decodeChatStartupIntent({
				operationId: "operation-1",
				initialSessionId: sessionId,
				startupInput: input,
			}),
		).toBeNull();
		expect(
			decodeChatStartupIntent({
				operationId: "operation-1",
				initialSessionId: sessionId,
				startupInput: input,
				startupQueueId: "startup-queue-1",
			}),
		).toMatchObject({
			operationId: "operation-1",
			sessionId,
			queueId: "startup-queue-1",
			ready: true,
		});
	});

	it("honors the durable context-preparation gate for plain input", () => {
		expect(
			decodeChatStartupIntent({
				operationId: "operation-held",
				initialSessionId: sessionId,
				startupInput: input,
				startupQueueId: "startup-queue-held",
				startupReady: false,
			}),
		).toMatchObject({ ready: false });
	});

	it("persists the stable queue command before marking creation successful", async () => {
		const order: string[] = [];
		const addQueuedMessage = vi.fn(
			(
				commandId: string,
				_sessionId: SessionId,
				_input: ComposerInput,
				_queueId: string,
				_ready: boolean,
				onCommitted: () => Effect.Effect<void>,
			) =>
				Effect.sync(() => order.push(`queue:${commandId}`)).pipe(
					Effect.andThen(onCommitted()),
				),
		);
		const queueTransaction = {
			addQueuedMessageTransactionally: addQueuedMessage,
		} as unknown as QueueTransactionServiceShape;
		const sqlTag = (strings: TemplateStringsArray) =>
			Effect.sync(() => {
				const statement = strings.join("?");
				order.push(statement);
				if (statement.includes("SELECT status")) return [{ status: "pending" }];
				return [];
			});
		const sql = Object.assign(sqlTag, {
			withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
		}) as unknown as SqlClient.SqlClient;

		const accepted = await Effect.runPromise(
			persistChatStartupIntent(queueTransaction, sql, {
				operationId: "operation-1",
				sessionId,
				input,
				queueId: "startup-queue-1",
				ready: true,
			}),
		);

		expect(accepted).toBe(true);
		expect(addQueuedMessage).toHaveBeenCalledWith(
			chatStartupCommandId("operation-1"),
			sessionId,
			input,
			"startup-queue-1",
			true,
			expect.any(Function),
		);
		expect(order[0]).toContain("SELECT status");
		expect(order[1]).toBe("queue:chat-create:operation-1:startup");
		expect(order[2]).toContain("UPDATE chat_creation_operations");
	});

	it("treats a succeeded operation as the receipt after a lost response", async () => {
		const queueTransaction = {
			addQueuedMessageTransactionally: vi.fn(),
		} as unknown as QueueTransactionServiceShape;
		const sqlTag = () => Effect.succeed([{ status: "succeeded" }]);
		const sql = Object.assign(sqlTag, {
			withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
		}) as unknown as SqlClient.SqlClient;

		const accepted = await Effect.runPromise(
			persistChatStartupIntent(queueTransaction, sql, {
				operationId: "operation-1",
				sessionId,
				input,
				queueId: "startup-queue-1",
				ready: true,
			}),
		);

		expect(accepted).toBe(false);
		expect(
			queueTransaction.addQueuedMessageTransactionally,
		).not.toHaveBeenCalled();
	});

	it("holds temporary attachment references until the renderer finalizes them", async () => {
		const pendingInput = ComposerInput.make({
			...input,
			attachments: [
				{
					id: "pending-upload",
					mimeType: "image/png",
					originalName: "capture.png",
				},
			],
		});
		const addQueuedMessage = vi.fn(
			(
				_commandId: string,
				_sessionId: SessionId,
				_input: ComposerInput,
				_queueId: string,
				_ready: boolean,
				onCommitted: () => Effect.Effect<void>,
			) => onCommitted(),
		);
		const queueTransaction = {
			addQueuedMessageTransactionally: addQueuedMessage,
		} as unknown as QueueTransactionServiceShape;

		await Effect.runPromise(
			persistChatStartupIntent(
				queueTransaction,
				Object.assign(
					(strings: TemplateStringsArray) => {
						const statement = strings.join("?");
						return statement.includes("SELECT status")
							? Effect.succeed([{ status: "pending" }])
							: Effect.succeed([]);
					},
					{
						withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
							effect,
					},
				) as unknown as SqlClient.SqlClient,
				{
					operationId: "operation-attachments",
					sessionId,
					input: pendingInput,
					queueId: "startup-queue-attachments",
					ready: true,
				},
			),
		);

		expect(addQueuedMessage).toHaveBeenCalledWith(
			chatStartupCommandId("operation-attachments"),
			sessionId,
			pendingInput,
			"startup-queue-attachments",
			false,
			expect.any(Function),
		);
	});

	it("does not publish success when durable queue acceptance fails", async () => {
		let updated = false;
		const queueTransaction = {
			addQueuedMessageTransactionally: () =>
				Effect.fail(new Error("disk unavailable")),
		} as unknown as QueueTransactionServiceShape;
		const sqlTag = (strings: TemplateStringsArray) =>
			Effect.sync(() => {
				const statement = strings.join("?");
				if (statement.includes("SELECT status")) return [{ status: "pending" }];
				updated = true;
				return [];
			});
		const sql = Object.assign(sqlTag, {
			withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
		}) as unknown as SqlClient.SqlClient;

		const result = await Effect.runPromiseExit(
			persistChatStartupIntent(queueTransaction, sql, {
				operationId: "operation-1",
				sessionId,
				input,
				queueId: "startup-queue-1",
				ready: true,
			}),
		);

		expect(result._tag).toBe("Failure");
		expect(updated).toBe(false);
	});
});
