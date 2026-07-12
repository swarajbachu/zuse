import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	createSystemConversation,
	initializeSystemRepository,
} from "../../src/conversation-fixture.ts";
import { waitForSessionMessages } from "../../src/session-observer.ts";
import { withSystemTest } from "../../src/system-scope.ts";

describe("permission recovery through production RPC", () => {
	it("restores and resolves a pending permission after process death", async () => {
		await withSystemTest("zuse-system-permission-", async (scope) => {
			const controller = await scope.controller();
			const repository = scope.path("repository");
			initializeSystemRepository(repository);
			let server = await scope.server({
				scenario: "permission",
				controlPort: controller.port,
			});
			let session = await scope.rpc(server.endpoint);
			const { conversation } = await createSystemConversation(
				session.client,
				repository,
				{ runtimeMode: "approval-required" },
			);
			const pendingRequest = Effect.runPromise(
				session.client["permission.requests"]({}).pipe(
					Stream.take(1),
					Stream.runCollect,
				),
			);
			await Effect.runPromise(
				session.client["messages.send"]({
					sessionId: conversation.initialSession.id,
					text: "Request a file permission.",
				}),
			);
			await controller.waitFor("permission.requested");
			const beforeRestart = Array.from(await pendingRequest);

			await session.dispose();
			await server.stop("SIGKILL");
			server = await scope.server({
				scenario: "permission",
				controlPort: controller.port,
			});
			session = await scope.rpc(server.endpoint);
			const resume = Effect.runPromise(
				session.client["session.resume"]({
					sessionId: conversation.initialSession.id,
				}),
			);
			await controller.waitFor("permission.resumed");

			const restored = await Effect.runPromise(
				session.client["permission.listPending"]({
					sessionId: conversation.initialSession.id,
				}),
			);
			const restoredRequest = restored[0];
			if (restoredRequest === undefined) {
				throw new Error("Expected the pending permission to survive restart");
			}
			expect(restored.map((request) => request.id)).toEqual([
				beforeRestart[0]?.id,
			]);
			await Effect.runPromise(
				session.client["permission.decide"]({
					requestId: restoredRequest.id,
					decision: { _tag: "AllowOnce" },
				}),
			);
			await controller.waitFor("permission.continued");
			await resume;
			await expect(
				Effect.runPromise(
					session.client["permission.decide"]({
						requestId: restoredRequest.id,
						decision: { _tag: "AllowOnce" },
					}),
				),
			).rejects.toBeDefined();
			expect(
				await Effect.runPromise(
					session.client["permission.listPending"]({
						sessionId: conversation.initialSession.id,
					}),
				),
			).toEqual([]);

			await waitForSessionMessages(
				session.client,
				conversation.initialSession.id,
				(message) =>
					message.content._tag === "assistant" &&
					message.content.text.includes("Permission accepted."),
			);
			const messages = await Effect.runPromise(
				session.client["messages.list"]({
					sessionId: conversation.initialSession.id,
				}),
			);
			expect(
				messages.some((message) => message.content._tag === "assistant"),
			).toBe(true);
			expect(
				messages.filter((message) => message.role === "user"),
			).toHaveLength(1);
			expect(
				messages.filter((message) => message.content._tag === "assistant"),
			).toHaveLength(1);
		});
	}, 60_000);
});
