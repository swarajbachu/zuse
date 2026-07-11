import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

describe("durable RPC operations", () => {
	it("recovers queued work exactly once after an abrupt server restart", async () => {
		const temporary = makeTemporaryDirectory("zuse-system-queue-");
		const controller = await startFakeAcpController();
		const repository = join(temporary.path, "repository");
		initializeSystemRepository(repository);
		let server = await startHeadlessServer({
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
			await controller.close();
			server = await startHeadlessServer({ root: temporary.path });
			session = await connectSystemRpc(server.endpoint);

			const messages = await eventually(
				() =>
					Effect.runPromise(
						session.client["messages.list"]({
							sessionId: conversation.initialSession.id,
						}),
					),
				(value) => {
					const recovered = value.filter(
						(message) =>
							message.content._tag === "user" &&
							message.content.text.startsWith("Recovered queued turn"),
					);
					return (
						recovered.length === 2 &&
						value.filter((message) => message.content._tag === "assistant")
							.length >= 2
					);
				},
				"recovered queued turns in order",
				20_000,
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
			const queue = await Effect.runPromise(
				session.client["messages.queue.list"]({
					sessionId: conversation.initialSession.id,
				}),
			);
			expect(queue.items).toEqual([]);
		} finally {
			await session.dispose();
			await server.stop();
			temporary.dispose();
		}
	}, 60_000);

	it("deduplicates concurrent client message identifiers and uses real Git", async () => {
		const temporary = makeTemporaryDirectory("zuse-system-idempotency-");
		const repository = join(temporary.path, "repository");
		initializeSystemRepository(repository);
		const server = await startHeadlessServer({ root: temporary.path });
		const session = await connectSystemRpc(server.endpoint);
		try {
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
			const messages = await eventually(
				() =>
					Effect.runPromise(
						session.client["messages.list"]({
							sessionId: conversation.initialSession.id,
						}),
					),
				(value) =>
					value.some((message) => message.content._tag === "assistant"),
				"idempotent provider response",
			);
			expect(
				messages.filter(
					(message) =>
						message.content._tag === "user" &&
						message.content.text === "Idempotent message",
				),
			).toHaveLength(1);
		} finally {
			await session.dispose();
			await server.stop();
			temporary.dispose();
		}
	}, 45_000);

	it("keeps parallel session streams isolated", async () => {
		const temporary = makeTemporaryDirectory("zuse-system-parallel-");
		const repository = join(temporary.path, "repository");
		initializeSystemRepository(repository);
		const server = await startHeadlessServer({ root: temporary.path });
		const session = await connectSystemRpc(server.endpoint);
		try {
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
			const [firstMessages, secondMessages] = await Promise.all([
				eventually(
					() =>
						Effect.runPromise(
							session.client["messages.list"]({
								sessionId: first.initialSession.id,
							}),
						),
					(messages) =>
						messages.some((message) => message.content._tag === "assistant"),
					"first parallel response",
				),
				eventually(
					() =>
						Effect.runPromise(
							session.client["messages.list"]({
								sessionId: second.initialSession.id,
							}),
						),
					(messages) =>
						messages.some((message) => message.content._tag === "assistant"),
					"second parallel response",
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
		} finally {
			await session.dispose();
			await server.stop();
			temporary.dispose();
		}
	}, 45_000);

	it("fails SQLite write contention promptly and recovers after release", async () => {
		const temporary = makeTemporaryDirectory("zuse-system-contention-");
		const repository = join(temporary.path, "repository");
		initializeSystemRepository(repository);
		const server = await startHeadlessServer({ root: temporary.path });
		const session = await connectSystemRpc(server.endpoint);
		const blocker = new DatabaseSync(join(server.userData, "zuse.sqlite"));
		try {
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
		} finally {
			try {
				blocker.exec("ROLLBACK");
			} catch {
				// The successful-path rollback already released the transaction.
			}
			blocker.close();
			await session.dispose();
			await server.stop();
			temporary.dispose();
		}
	}, 30_000);
});
