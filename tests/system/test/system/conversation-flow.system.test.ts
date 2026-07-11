import { MessageId } from "@zuse/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	createSystemConversation,
	initializeSystemRepository,
} from "../../src/conversation-fixture.ts";
import { waitForSessionMessages } from "../../src/session-observer.ts";
import { withSystemTest } from "../../src/system-scope.ts";

describe("conversation flow through production RPC", () => {
	it("persists a deterministic provider turn and restores it after restart", async () => {
		await withSystemTest("zuse-system-flow-", async (scope) => {
			const repository = scope.path("repository");
			initializeSystemRepository(repository);

			let server = await scope.server();
			let session = await scope.rpc(server.endpoint);
			const { conversation: created } = await createSystemConversation(
				session.client,
				repository,
			);
			await Effect.runPromise(
				session.client["messages.send"]({
					sessionId: created.initialSession.id,
					text: "Respond through the real provider protocol.",
					clientMessageId: MessageId.make("system-user-message"),
				}),
			);

			await waitForSessionMessages(
				session.client,
				created.initialSession.id,
				(message) =>
					message.content._tag === "assistant" &&
					message.content.text.includes("Hello from deterministic provider."),
			);
			const messages = await Effect.runPromise(
				session.client["messages.list"]({
					sessionId: created.initialSession.id,
				}),
			);
			expect(
				messages.filter((message) => message.role === "user"),
			).toHaveLength(1);
			const completedSession = await Effect.runPromise(
				session.client["session.get"]({
					sessionId: created.initialSession.id,
				}),
			);
			expect(completedSession.status).toBe("idle");
			expect(completedSession.cursor).not.toBeNull();

			await session.dispose();
			await server.stop("SIGKILL");
			server = await scope.server();
			session = await scope.rpc(server.endpoint);

			const restored = await Effect.runPromise(
				session.client["messages.list"]({
					sessionId: created.initialSession.id,
				}),
			);
			const restoredSession = await Effect.runPromise(
				session.client["session.get"]({
					sessionId: created.initialSession.id,
				}),
			);
			expect(restoredSession.status).toBe("idle");
			expect(restoredSession.cursor).toBe(completedSession.cursor);
			expect(
				restored.some(
					(message) =>
						message.content._tag === "assistant" &&
						message.content.text.includes("Hello from deterministic provider."),
				),
			).toBe(true);

			await Effect.runPromise(
				session.client["chat.archive"]({ chatId: created.chat.id }),
			);
			await session.dispose();
			await server.stop();
			server = await scope.server();
			session = await scope.rpc(server.endpoint);
			const archived = await Effect.runPromise(
				session.client["chat.list"]({
					projectId: created.chat.projectId,
					includeArchived: true,
				}),
			);
			expect(
				archived.find((chat) => chat.id === created.chat.id)?.archivedAt,
			).not.toBeNull();
			await Effect.runPromise(
				session.client["chat.delete"]({ chatId: created.chat.id }),
			);
			await expect(
				Effect.runPromise(
					session.client["chat.get"]({ chatId: created.chat.id }),
				),
			).rejects.toMatchObject({ _tag: "ChatNotFoundError" });
			await session.dispose();
			await server.stop();
			server = await scope.server();
			session = await scope.rpc(server.endpoint);
			await expect(
				Effect.runPromise(
					session.client["chat.get"]({ chatId: created.chat.id }),
				),
			).rejects.toMatchObject({ _tag: "ChatNotFoundError" });
		});
	}, 45_000);
});
