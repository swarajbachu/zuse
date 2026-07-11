import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MessageId } from "@zuse/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	createSystemConversation,
	initializeSystemRepository,
} from "../../src/conversation-fixture.ts";
import { waitForSessionMessages } from "../../src/session-observer.ts";
import { withSystemTest } from "../../src/system-scope.ts";

describe("durable RPC operations", () => {
	it("recovers queued work exactly once after an abrupt server restart", async () => {
		await withSystemTest("zuse-system-queue-", async (scope) => {
			const controller = await scope.controller();
			const repository = scope.path("repository");
			initializeSystemRepository(repository);
			let server = await scope.server({
				scenario: "hold",
				controlPort: controller.port,
			});
			let session = await scope.rpc(server.endpoint);
			const { conversation } = await createSystemConversation(
				session.client,
				repository,
			);
			await Effect.runPromise(
				session.client["messages.send"]({
					sessionId: conversation.initialSession.id,
					text: "Keep the first turn running.",
				}),
			);
			await controller.waitFor("prompt.held");
			for (const text of [
				"Recovered queued turn 1",
				"Recovered queued turn 2",
			]) {
				await Effect.runPromise(
					session.client["messages.queue.add"]({
						sessionId: conversation.initialSession.id,
						input: {
							text,
							attachments: [],
							fileRefs: [],
							skillRefs: [],
							annotations: [],
						},
					}),
				);
			}

			await session.dispose();
			await server.stop("SIGKILL");
			server = await scope.server({
				controlPort: controller.port,
			});
			session = await scope.rpc(server.endpoint);

			for (const text of [
				"Recovered queued turn 1",
				"Recovered queued turn 2",
			]) {
				await controller.waitFor(
					"prompt.received",
					(event) =>
						typeof event.prompt === "string" && event.prompt.includes(text),
					20_000,
				);
			}

			await waitForSessionMessages(
				session.client,
				conversation.initialSession.id,
				(message) => message.content._tag === "assistant",
				2,
				20_000,
			);
			const messages = await Effect.runPromise(
				session.client["messages.list"]({
					sessionId: conversation.initialSession.id,
				}),
			);
			const recoveredTexts = messages
				.filter(
					(message) =>
						message.content._tag === "user" &&
						message.content.text.startsWith("Recovered queued turn"),
				)
				.map((message) =>
					message.content._tag === "user" ? message.content.text : "",
				);
			expect(recoveredTexts).toEqual([
				"Recovered queued turn 1",
				"Recovered queued turn 2",
			]);
			for (const text of [
				"Recovered queued turn 1",
				"Recovered queued turn 2",
			]) {
				expect(
					controller
						.events("prompt.received")
						.filter(
							(event) =>
								typeof event.prompt === "string" && event.prompt.includes(text),
						),
				).toHaveLength(1);
			}
			const queue = await Effect.runPromise(
				session.client["messages.queue.list"]({
					sessionId: conversation.initialSession.id,
				}),
			);
			expect(queue.items).toEqual([]);
		});
	}, 60_000);

	it("deduplicates concurrent client message identifiers and uses real Git", async () => {
		await withSystemTest("zuse-system-idempotency-", async (scope) => {
			const repository = scope.path("repository");
			initializeSystemRepository(repository);
			const server = await scope.server();
			const session = await scope.rpc(server.endpoint);
			const { folder, conversation } = await createSystemConversation(
				session.client,
				repository,
			);
			const status = await Effect.runPromise(
				session.client["git.status"]({ folderId: folder.id }),
			);
			expect(status.branch).toBe("main");
			const log = await Effect.runPromise(
				session.client["git.log"]({ folderId: folder.id, limit: 1 }),
			);
			expect(log.map((commit) => commit.subject)).toEqual(["Initial fixture"]);

			const worktree = await Effect.runPromise(
				session.client["worktree.create"]({ projectId: folder.id }),
			);
			writeFileSync(join(worktree.path, "dirty.txt"), "dirty\n");
			await expect(
				Effect.runPromise(
					session.client["worktree.remove"]({ worktreeId: worktree.id }),
				),
			).rejects.toBeDefined();
			await Effect.runPromise(
				session.client["worktree.remove"]({
					worktreeId: worktree.id,
					force: true,
				}),
			);

			const payload = {
				sessionId: conversation.initialSession.id,
				text: "Idempotent message",
				clientMessageId: MessageId.make("same-client-message"),
			};
			await Promise.allSettled([
				Effect.runPromise(session.client["messages.send"](payload)),
				Effect.runPromise(session.client["messages.send"](payload)),
			]);
			await waitForSessionMessages(
				session.client,
				conversation.initialSession.id,
				(message) => message.content._tag === "assistant",
			);
			const messages = await Effect.runPromise(
				session.client["messages.list"]({
					sessionId: conversation.initialSession.id,
				}),
			);
			expect(
				messages.filter(
					(message) =>
						message.content._tag === "user" &&
						message.content.text === "Idempotent message",
				),
			).toHaveLength(1);
		});
	}, 45_000);

	it("keeps parallel session streams isolated", async () => {
		await withSystemTest("zuse-system-parallel-", async (scope) => {
			const repository = scope.path("repository");
			initializeSystemRepository(repository);
			const server = await scope.server();
			const session = await scope.rpc(server.endpoint);
			const folder = await Effect.runPromise(
				session.client["workspace.add"]({ path: repository }),
			);
			const makeConversation = (title: string) =>
				Effect.runPromise(
					session.client["chat.create"]({
						projectId: folder.id,
						providerId: "gemini",
						model: "deterministic-model",
						title,
					}),
				);
			const [first, second] = await Promise.all([
				makeConversation("First parallel chat"),
				makeConversation("Second parallel chat"),
			]);
			await Promise.all([
				Effect.runPromise(
					session.client["messages.send"]({
						sessionId: first.initialSession.id,
						text: "first-only",
					}),
				),
				Effect.runPromise(
					session.client["messages.send"]({
						sessionId: second.initialSession.id,
						text: "second-only",
					}),
				),
			]);
			await Promise.all([
				waitForSessionMessages(
					session.client,
					first.initialSession.id,
					(message) => message.content._tag === "assistant",
				),
				waitForSessionMessages(
					session.client,
					second.initialSession.id,
					(message) => message.content._tag === "assistant",
				),
			]);
			const [firstMessages, secondMessages] = await Promise.all([
				Effect.runPromise(
					session.client["messages.list"]({
						sessionId: first.initialSession.id,
					}),
				),
				Effect.runPromise(
					session.client["messages.list"]({
						sessionId: second.initialSession.id,
					}),
				),
			]);
			expect(
				firstMessages.some(
					(message) =>
						message.content._tag === "user" &&
						message.content.text === "second-only",
				),
			).toBe(false);
			expect(
				secondMessages.some(
					(message) =>
						message.content._tag === "user" &&
						message.content.text === "first-only",
				),
			).toBe(false);
		});
	}, 45_000);

	it("fails SQLite write contention promptly and recovers after release", async () => {
		await withSystemTest("zuse-system-contention-", async (scope) => {
			const repository = scope.path("repository");
			initializeSystemRepository(repository);
			const server = await scope.server();
			const session = await scope.rpc(server.endpoint);
			const blocker = await scope.acquire(
				() => new DatabaseSync(join(server.userData, "zuse.sqlite")),
				(database) => database.close(),
			);
			scope.defer(() => {
				try {
					blocker.exec("ROLLBACK");
				} catch {
					// The successful-path rollback already released the transaction.
				}
			});
			blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
			const startedAt = Date.now();
			await expect(
				Effect.runPromise(
					session.client["workspace.add"]({ path: repository }),
				),
			).rejects.toBeDefined();
			expect(Date.now() - startedAt).toBeLessThan(2_000);

			blocker.exec("ROLLBACK");
			const folder = await Effect.runPromise(
				session.client["workspace.add"]({ path: repository }),
			);
			expect(folder.path).toBe(repository);
		});
	}, 30_000);
});
