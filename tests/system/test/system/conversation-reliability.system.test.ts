import { join } from "node:path";
import { projectSessionEvent } from "@zuse/client-runtime/session-events";
import { MessageId } from "@zuse/contracts";
import {
	eventually,
	makeTemporaryDirectory,
	startFakeAcpController,
} from "@zuse/testkit";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	createSystemConversation,
	initializeSystemRepository,
} from "../../src/conversation-fixture.ts";
import { startHeadlessServer } from "../../src/headless-server.ts";
import { connectSystemRpc } from "../../src/rpc-client.ts";

describe("conversation process reliability", () => {
	it("reconnects during a held stream without duplicating the turn", async () => {
		const temporary = makeTemporaryDirectory("zuse-system-reconnect-");
		const controller = await startFakeAcpController();
		const repository = join(temporary.path, "repository");
		initializeSystemRepository(repository);
		const server = await startHeadlessServer({
			root: temporary.path,
			scenario: "hold",
			controlPort: controller.port,
		});
		let session = await connectSystemRpc(server.endpoint);
		try {
			const { conversation } = await createSystemConversation(
				session.client,
				repository,
			);
			await Effect.runPromise(
				session.client["messages.send"]({
					sessionId: conversation.initialSession.id,
					text: "Hold this stream while the client reconnects.",
					clientMessageId: MessageId.make("reconnect-user-message"),
				}),
			);
			await controller.waitFor("prompt.held");
			const beforeDrop = await Effect.runPromise(
				Stream.runCollect(
					session.client["session.events"]({
						sessionId: conversation.initialSession.id,
					}).pipe(
						Stream.takeUntil(
							(envelope) => projectSessionEvent(envelope)._tag === "message",
						),
					),
				),
			);
			const cursor = beforeDrop.at(-1)?.sequence;
			if (cursor === undefined)
				throw new Error("No replay cursor before disconnect.");

			await session.dispose();
			session = await connectSystemRpc(server.endpoint);
			controller.send({ action: "complete", text: " world" });
			const resumed = await Effect.runPromise(
				Stream.runCollect(
					session.client["session.events"]({
						sessionId: conversation.initialSession.id,
						afterSequence: cursor,
					}).pipe(
						Stream.takeUntil((envelope) => {
							const projected = projectSessionEvent(envelope);
							return (
								projected._tag === "message" &&
								projected.message.content._tag === "assistant"
							);
						}),
					),
				),
			);
			expect(resumed.every((envelope) => envelope.sequence > cursor)).toBe(
				true,
			);
			expect(new Set(resumed.map((envelope) => envelope.sequence)).size).toBe(
				resumed.length,
			);
			expect(
				resumed.filter(
					(envelope) => projectSessionEvent(envelope)._tag === "message",
				),
			).toHaveLength(1);

			const messages = await eventually(
				() =>
					Effect.runPromise(
						session.client["messages.list"]({
							sessionId: conversation.initialSession.id,
						}),
					),
				(value) =>
					value.some(
						(message) =>
							message.content._tag === "assistant" &&
							message.content.text.includes("Hello world"),
					),
				"completed response after reconnect",
			);
			expect(
				messages.filter((message) => message.role === "user"),
			).toHaveLength(1);
			expect(
				messages.filter((message) => message.content._tag === "assistant"),
			).toHaveLength(1);
		} finally {
			await session.dispose();
			await server.stop();
			await controller.close();
			temporary.dispose();
		}
	}, 45_000);

	it("interrupts a live provider prompt and rejects late completion", async () => {
		const temporary = makeTemporaryDirectory("zuse-system-interrupt-");
		const controller = await startFakeAcpController();
		const repository = join(temporary.path, "repository");
		initializeSystemRepository(repository);
		const server = await startHeadlessServer({
			root: temporary.path,
			scenario: "hold",
			controlPort: controller.port,
		});
		const session = await connectSystemRpc(server.endpoint);
		try {
			const { conversation } = await createSystemConversation(
				session.client,
				repository,
			);
			await Effect.runPromise(
				session.client["messages.send"]({
					sessionId: conversation.initialSession.id,
					text: "Wait for interruption.",
				}),
			);
			await controller.waitFor("prompt.held");
			await Effect.runPromise(
				session.client["messages.interrupt"]({
					sessionId: conversation.initialSession.id,
				}),
			);
			await controller.waitFor("prompt.cancelled");
			controller.send({ action: "complete", text: " should-not-arrive" });

			const messages = await eventually(
				() =>
					Effect.runPromise(
						session.client["messages.list"]({
							sessionId: conversation.initialSession.id,
						}),
					),
				(value) =>
					value.some((message) => message.content._tag === "interrupted"),
				"durable interrupted marker",
			);
			expect(
				messages.some(
					(message) =>
						message.content._tag === "assistant" &&
						message.content.text.includes("should-not-arrive"),
				),
			).toBe(false);
		} finally {
			await session.dispose();
			await server.stop();
			await controller.close();
			temporary.dispose();
		}
	}, 45_000);

	it("persists a provider crash as a terminal error instead of hanging", async () => {
		const temporary = makeTemporaryDirectory("zuse-system-crash-");
		const repository = join(temporary.path, "repository");
		initializeSystemRepository(repository);
		let server = await startHeadlessServer({
			root: temporary.path,
			scenario: "crash",
		});
		let session = await connectSystemRpc(server.endpoint);
		try {
			const { conversation } = await createSystemConversation(
				session.client,
				repository,
			);
			await Effect.runPromise(
				session.client["messages.send"]({
					sessionId: conversation.initialSession.id,
					text: "Crash deterministically.",
				}),
			);
			const messages = await eventually(
				() =>
					Effect.runPromise(
						session.client["messages.list"]({
							sessionId: conversation.initialSession.id,
						}),
					),
				(value) => value.some((message) => message.content._tag === "error"),
				"provider crash error",
			);
			expect(messages.some((message) => message.content._tag === "error")).toBe(
				true,
			);
			expect(
				(
					await Effect.runPromise(
						session.client["session.get"]({
							sessionId: conversation.initialSession.id,
						}),
					)
				).status,
			).not.toBe("running");

			await session.dispose();
			await server.stop();
			server = await startHeadlessServer({ root: temporary.path });
			session = await connectSystemRpc(server.endpoint);
			await Effect.runPromise(
				session.client["session.resume"]({
					sessionId: conversation.initialSession.id,
				}),
			);
			await Effect.runPromise(
				session.client["messages.send"]({
					sessionId: conversation.initialSession.id,
					text: "Recover after the provider crash.",
				}),
			);
			const recovered = await eventually(
				() =>
					Effect.runPromise(
						session.client["messages.list"]({
							sessionId: conversation.initialSession.id,
						}),
					),
				(value) =>
					value.some(
						(message) =>
							message.content._tag === "assistant" &&
							message.content.text.includes(
								"Hello from deterministic provider.",
							),
					),
				"turn after provider crash recovery",
			);
			expect(
				recovered.some((message) => message.content._tag === "assistant"),
			).toBe(true);
		} finally {
			await session.dispose();
			await server.stop();
			temporary.dispose();
		}
	}, 45_000);

	it("ignores a malformed stdout frame and accepts the next valid provider frame", async () => {
		const temporary = makeTemporaryDirectory("zuse-system-malformed-");
		const repository = join(temporary.path, "repository");
		initializeSystemRepository(repository);
		const server = await startHeadlessServer({
			root: temporary.path,
			scenario: "malformed",
		});
		const session = await connectSystemRpc(server.endpoint);
		try {
			const { conversation } = await createSystemConversation(
				session.client,
				repository,
			);
			await Effect.runPromise(
				session.client["messages.send"]({
					sessionId: conversation.initialSession.id,
					text: "Emit a malformed provider frame.",
				}),
			);
			const messages = await eventually(
				() =>
					Effect.runPromise(
						session.client["messages.list"]({
							sessionId: conversation.initialSession.id,
						}),
					),
				(value) =>
					value.some(
						(message) =>
							message.content._tag === "assistant" &&
							message.content.text.includes(
								"Hello from deterministic provider.",
							),
					),
				"valid response after malformed provider noise",
			);
			expect(messages.some((message) => message.content._tag === "error")).toBe(
				false,
			);
			expect(
				messages.filter((message) => message.content._tag === "assistant"),
			).toHaveLength(1);
		} finally {
			await session.dispose();
			await server.stop();
			temporary.dispose();
		}
	}, 45_000);

	it("cancels a stalled provider within a bounded wait", async () => {
		const temporary = makeTemporaryDirectory("zuse-system-stall-");
		const controller = await startFakeAcpController();
		const repository = join(temporary.path, "repository");
		initializeSystemRepository(repository);
		const server = await startHeadlessServer({
			root: temporary.path,
			scenario: "stall",
			controlPort: controller.port,
		});
		const session = await connectSystemRpc(server.endpoint);
		try {
			const { conversation } = await createSystemConversation(
				session.client,
				repository,
			);
			await Effect.runPromise(
				session.client["messages.send"]({
					sessionId: conversation.initialSession.id,
					text: "Stall until cancelled.",
				}),
			);
			await controller.waitFor("prompt.received");
			await Effect.runPromise(
				session.client["messages.interrupt"]({
					sessionId: conversation.initialSession.id,
				}),
			);
			await controller.waitFor("prompt.cancelled", undefined, 2_000);
			const messages = await eventually(
				() =>
					Effect.runPromise(
						session.client["messages.list"]({
							sessionId: conversation.initialSession.id,
						}),
					),
				(value) =>
					value.some((message) => message.content._tag === "interrupted"),
				"bounded stalled-provider cancellation",
				2_000,
			);
			expect(
				messages.some((message) => message.content._tag === "interrupted"),
			).toBe(true);
		} finally {
			await session.dispose();
			await server.stop();
			await controller.close();
			temporary.dispose();
		}
	}, 45_000);
});
