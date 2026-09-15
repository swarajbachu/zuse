import { CommandId } from "@zuse/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	createSystemConversation,
	initializeSystemRepository,
} from "../../src/conversation-fixture.ts";
import { withSystemTest } from "../../src/system-scope.ts";

describe("permission recovery through production RPC", () => {
	it("expires an interrupted permission and requires a fresh approval after process death", async () => {
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
					Stream.flatMap((change) =>
						change._tag === "snapshot"
							? Stream.fromIterable(change.requests)
							: change._tag === "change"
								? Stream.succeed(change.request)
								: Stream.empty,
					),
					Stream.take(1),
					Stream.runCollect,
				),
			);
			await Effect.runPromise(
				session.client["messages.send"]({
					sessionId: conversation.initialSession.id,
					commandId: CommandId.make("permission-restart-send"),
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
			const expiredRequest = restored.find(
				(request) => request.id === beforeRestart[0]?.id,
			);
			expect(expiredRequest?.recoveryState).toBe("expired");
			if (expiredRequest === undefined)
				throw new Error("Missing expired permission");
			await expect(
				Effect.runPromise(
					session.client["permission.decide"]({
						requestId: expiredRequest.id,
						decision: { _tag: "AllowOnce" },
					}),
				),
			).rejects.toMatchObject({ _tag: "PermissionRequestExpiredError" });
			await Effect.runPromise(
				session.client["permission.decide"]({
					requestId: expiredRequest.id,
					decision: { _tag: "Deny" },
				}),
			);
			const restoredRequest = restored.find(
				(request) => request.id !== expiredRequest.id,
			);
			if (restoredRequest === undefined)
				throw new Error("Missing fresh permission");
			expect(restoredRequest.recoveryState).not.toBe("expired");
			expect(restored).toHaveLength(2);
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
			).resolves.toBeUndefined();
			expect(
				await Effect.runPromise(
					session.client["permission.listPending"]({
						sessionId: conversation.initialSession.id,
					}),
				),
			).toEqual([]);

			const messages = await Effect.runPromise(
				session.client["messages.list"]({
					sessionId: conversation.initialSession.id,
				}),
			);
			expect(
				messages.filter((message) => message.role === "user"),
			).toHaveLength(1);
			// Restart ended the interrupted turn. Session-load updates must not
			// resurrect it as a newly completed assistant response.
			expect(
				messages.filter((message) => message.content._tag === "assistant"),
			).toHaveLength(0);
		});
	}, 60_000);
});
