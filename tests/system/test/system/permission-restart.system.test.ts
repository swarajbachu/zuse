import { join } from "node:path";
import { MessageId } from "@zuse/contracts";
import {
	eventually,
	makeTemporaryDirectory,
	startFakeAcpController,
} from "@zuse/testkit";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	createSystemConversation,
	initializeSystemRepository,
} from "../../src/conversation-fixture.ts";
import { startHeadlessServer } from "../../src/headless-server.ts";
import { connectSystemRpc } from "../../src/rpc-client.ts";

describe("permission recovery through production RPC", () => {
	it("restores and resolves a pending permission after process death", async () => {
		const temporary = makeTemporaryDirectory("zuse-system-permission-");
		const controller = await startFakeAcpController();
		const repository = join(temporary.path, "repository");
		initializeSystemRepository(repository);
		let server = await startHeadlessServer({
			root: temporary.path,
			scenario: "permission",
			controlPort: controller.port,
		});
		let session = await connectSystemRpc(server.endpoint);
		try {
			const { conversation } = await createSystemConversation(
				session.client,
				repository,
				{ runtimeMode: "approval-required" },
			);
			await Effect.runPromise(
				session.client["messages.send"]({
					sessionId: conversation.initialSession.id,
					text: "Request a file permission.",
				}),
			);
			await controller.waitFor("permission.requested");
			const beforeRestart = await eventually(
				() =>
					Effect.runPromise(
						session.client["permission.listPending"]({
							sessionId: conversation.initialSession.id,
						}),
					),
				(value) => value.length === 1,
				"pending permission before restart",
			);

			await session.dispose();
			await server.stop("SIGKILL");
			await controller.close();
			server = await startHeadlessServer({ root: temporary.path });
			session = await connectSystemRpc(server.endpoint);

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

			await Effect.runPromise(
				session.client["session.resume"]({
					sessionId: conversation.initialSession.id,
				}),
			);
			await Effect.runPromise(
				session.client["messages.send"]({
					sessionId: conversation.initialSession.id,
					text: "Continue after permission recovery.",
					clientMessageId: MessageId.make("permission-recovery-continuation"),
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
					value.some((message) => message.content._tag === "assistant"),
				"turn after permission recovery",
			);
			expect(
				messages.some((message) => message.content._tag === "assistant"),
			).toBe(true);
			expect(
				messages.filter(
					(message) =>
						message.content._tag === "user" &&
						message.content.text === "Continue after permission recovery.",
				),
			).toHaveLength(1);
		} finally {
			await session.dispose();
			await server.stop();
			await controller.close();
			temporary.dispose();
		}
	}, 60_000);
});
