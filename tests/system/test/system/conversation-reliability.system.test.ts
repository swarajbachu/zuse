import type { ClientSession } from "@zuse/client-runtime/connection";
import { MessageId } from "@zuse/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	createSystemConversation,
	initializeSystemRepository,
} from "../../src/conversation-fixture.ts";
import type { SystemRpcClient } from "../../src/rpc-client.ts";
import {
	sessionFrameMessages,
	sessionFrameVersion,
	waitForActiveTurn,
	waitForSessionMessages,
} from "../../src/session-observer.ts";
import { withSystemTest } from "../../src/system-scope.ts";

describe("conversation process reliability", () => {
	it("reconnects during a held stream without duplicating the turn", async () => {
		await withSystemTest("zuse-system-reconnect-", async (scope) => {
			const controller = await scope.controller();
			const repository = scope.path("repository");
			initializeSystemRepository(repository);
			const server = await scope.server({
				scenario: "hold",
				controlPort: controller.port,
			});
			const droppedSession = await scope.droppableRpc(server.endpoint);
			let session: ClientSession<SystemRpcClient> = droppedSession;
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
						Stream.takeUntil((frame) => sessionFrameMessages(frame).length > 0),
					),
				),
			);
			const lastFrame = beforeDrop.at(-1);
			const cursor =
				lastFrame === undefined ? undefined : sessionFrameVersion(lastFrame);
			if (cursor === undefined)
				throw new Error("No replay cursor before disconnect.");

			droppedSession.drop();
			await droppedSession.dispose();
			session = await scope.rpc(server.endpoint);
			controller.send({ action: "complete", text: " world" });
			const resumed = await Effect.runPromise(
				Stream.runCollect(
					session.client["session.events"]({
						sessionId: conversation.initialSession.id,
						afterVersion: cursor,
						hasProjection: true,
					}).pipe(
						Stream.takeUntil((frame) =>
							sessionFrameMessages(frame).some(
								(message) => message.content._tag === "assistant",
							),
						),
					),
				),
			);
			const resumedEvents = resumed.filter((frame) => frame.kind === "event");
			expect(resumedEvents.every((frame) => frame.streamVersion > cursor)).toBe(
				true,
			);
			expect(
				new Set(resumedEvents.map((frame) => frame.streamVersion)).size,
			).toBe(resumedEvents.length);
			expect(resumed.flatMap(sessionFrameMessages)).toHaveLength(1);

			await waitForSessionMessages(
				session.client,
				conversation.initialSession.id,
				(message) =>
					message.content._tag === "assistant" &&
					message.content.text.includes("Hello world"),
			);
			const messages = await Effect.runPromise(
				session.client["messages.list"]({
					sessionId: conversation.initialSession.id,
				}),
			);
			expect(
				messages.filter((message) => message.role === "user"),
			).toHaveLength(1);
			expect(
				messages.filter((message) => message.content._tag === "assistant"),
			).toHaveLength(1);
		});
	}, 45_000);

	it("interrupts a live provider prompt and rejects late completion", async () => {
		await withSystemTest("zuse-system-interrupt-", async (scope) => {
			const controller = await scope.controller();
			const repository = scope.path("repository");
			initializeSystemRepository(repository);
			const server = await scope.server({
				scenario: "hold",
				controlPort: controller.port,
			});
			const session = await scope.rpc(server.endpoint);
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
			const turnId = await waitForActiveTurn(
				session.client,
				conversation.initialSession.id,
			);
			await Effect.runPromise(
				session.client["messages.interrupt"]({
					sessionId: conversation.initialSession.id,
					turnId,
				}),
			);
			await controller.waitFor("prompt.cancelled");
			controller.send({ action: "complete", text: " should-not-arrive" });

			await waitForSessionMessages(
				session.client,
				conversation.initialSession.id,
				(message) => message.content._tag === "interrupted",
			);
			const messages = await Effect.runPromise(
				session.client["messages.list"]({
					sessionId: conversation.initialSession.id,
				}),
			);
			expect(
				messages.some(
					(message) =>
						message.content._tag === "assistant" &&
						message.content.text.includes("should-not-arrive"),
				),
			).toBe(false);
		});
	}, 45_000);

	it("persists a provider crash as a terminal error instead of hanging", async () => {
		await withSystemTest("zuse-system-crash-", async (scope) => {
			const repository = scope.path("repository");
			initializeSystemRepository(repository);
			let server = await scope.server({ scenario: "crash" });
			let session = await scope.rpc(server.endpoint);
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
			await waitForSessionMessages(
				session.client,
				conversation.initialSession.id,
				(message) => message.content._tag === "error",
			);
			const messages = await Effect.runPromise(
				session.client["messages.list"]({
					sessionId: conversation.initialSession.id,
				}),
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
			server = await scope.server();
			session = await scope.rpc(server.endpoint);
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
			await waitForSessionMessages(
				session.client,
				conversation.initialSession.id,
				(message) =>
					message.content._tag === "assistant" &&
					message.content.text.includes("Hello from deterministic provider."),
			);
			const recovered = await Effect.runPromise(
				session.client["messages.list"]({
					sessionId: conversation.initialSession.id,
				}),
			);
			expect(
				recovered.some((message) => message.content._tag === "assistant"),
			).toBe(true);
		});
	}, 45_000);

	it("ignores a malformed stdout frame and accepts the next valid provider frame", async () => {
		await withSystemTest("zuse-system-malformed-", async (scope) => {
			const repository = scope.path("repository");
			initializeSystemRepository(repository);
			const server = await scope.server({ scenario: "malformed" });
			const session = await scope.rpc(server.endpoint);
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
			await waitForSessionMessages(
				session.client,
				conversation.initialSession.id,
				(message) =>
					message.content._tag === "assistant" &&
					message.content.text.includes("Hello from deterministic provider."),
			);
			const messages = await Effect.runPromise(
				session.client["messages.list"]({
					sessionId: conversation.initialSession.id,
				}),
			);
			expect(messages.some((message) => message.content._tag === "error")).toBe(
				false,
			);
			expect(
				messages.filter((message) => message.content._tag === "assistant"),
			).toHaveLength(1);
		});
	}, 45_000);

	it("cancels a stalled provider within a bounded wait", async () => {
		await withSystemTest("zuse-system-stall-", async (scope) => {
			const controller = await scope.controller();
			const repository = scope.path("repository");
			initializeSystemRepository(repository);
			const server = await scope.server({
				scenario: "stall",
				controlPort: controller.port,
			});
			const session = await scope.rpc(server.endpoint);
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
			const turnId = await waitForActiveTurn(
				session.client,
				conversation.initialSession.id,
			);
			await Effect.runPromise(
				session.client["messages.interrupt"]({
					sessionId: conversation.initialSession.id,
					turnId,
				}),
			);
			await controller.waitFor("prompt.cancelled", undefined, 2_000);
			await waitForSessionMessages(
				session.client,
				conversation.initialSession.id,
				(message) => message.content._tag === "interrupted",
				1,
				2_000,
			);
			const messages = await Effect.runPromise(
				session.client["messages.list"]({
					sessionId: conversation.initialSession.id,
				}),
			);
			expect(
				messages.some((message) => message.content._tag === "interrupted"),
			).toBe(true);
		});
	}, 45_000);
});
