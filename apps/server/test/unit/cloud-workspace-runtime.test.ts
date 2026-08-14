import {
	AgentSessionId,
	Message,
	MessageId,
	QueueState,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { bytesToBase64Url } from "@zuse/utils/cloud-transcript-crypto";
import { Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
import { generateKeyPair, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
	bufferWorkspaceLocalFrame,
	makeCloudRuntimeCheckpointPublisher,
	makeCloudRuntimeSummaryPublisher,
	retryCloudWorkspaceBootstrap,
	runtimeCredentialRenewalDelayMs,
	runtimeReadyPhaseOnGatewayOpen,
	signRuntimeRenewalProof,
	startCloudWorkspaceLaunchIntent,
} from "../../src/relay/cloud-workspace-runtime.ts";

describe("cloud workspace bootstrap", () => {
	it("publishes bounded older transcript pages only for an urgent checkpoint", async () => {
		const sessionId = AgentSessionId.make("session-pages");
		const older = Message.make({
			id: MessageId.make("message-older"),
			sessionId,
			role: "assistant",
			content: { _tag: "assistant", text: "older durable output" },
			createdAt: new Date(1),
		});
		const headWrites: unknown[] = [];
		const pageWrites: Array<{ readonly beforeSequence: number }> = [];
		const publisher = await Effect.runPromise(
			makeCloudRuntimeCheckpointPublisher({
				workspaceId: "workspace-pages",
				sessionId,
				transcriptKey: bytesToBase64Url(new Uint8Array(32).fill(7)),
				read: Effect.succeed({
					cursor: { epoch: "epoch-pages", version: 9 },
					projection: SessionTimelineProjection.make({
						messages: [],
						olderMessageSequence: 20,
						status: "idle",
						currentTurn: null,
						queue: QueueState.make({ items: [], paused: false }),
						permissionMode: "default",
						runtimeMode: "approval-required",
					}),
				}),
				readPage: () =>
					Effect.succeed({
						messages: [older],
						olderMessageSequence: null,
					}),
				write: (checkpoint) =>
					Effect.sync(() => {
						headWrites.push(checkpoint);
					}),
				writePage: (page) =>
					Effect.sync(() => {
						pageWrites.push(page);
					}),
			}),
		);

		publisher.mark(true);
		expect(await Effect.runPromise(publisher.flush)).toBe(true);
		expect(headWrites).toHaveLength(1);
		expect(pageWrites).toEqual([
			expect.objectContaining({ beforeSequence: 20 }),
		]);
		expect(await Effect.runPromise(publisher.flush)).toBe(false);
	});

	it("publishes monotonic metadata and throttles only activity checkpoints", async () => {
		let now = 1_000;
		let title = "Initial title";
		let head = 4;
		const writes: Array<Record<string, unknown>> = [];
		const publisher = await Effect.runPromise(
			makeCloudRuntimeSummaryPublisher({
				now: Effect.sync(() => now),
				read: Effect.sync(() => ({
					title,
					lastActivityAt: now,
					sessionHeadVersion: head,
				})),
				write: (summary) =>
					Effect.sync(() => {
						writes.push({ ...summary });
						return {
							applied: true,
							summaryRevision: summary.summaryRevision,
						};
					}),
			}),
		);

		expect(await Effect.runPromise(publisher.publish("activity"))).toBe(true);
		now += 1_000;
		expect(await Effect.runPromise(publisher.publish("activity"))).toBe(false);
		title = "Renamed immediately";
		head = 7;
		expect(await Effect.runPromise(publisher.publish("title"))).toBe(true);
		expect(await Effect.runPromise(publisher.publish("settled"))).toBe(true);

		expect(writes).toEqual([
			{
				summaryRevision: 1,
				title: "Initial title",
				lastActivityAt: 1_000,
				sessionHeadVersion: 4,
			},
			{
				summaryRevision: 2,
				title: "Renamed immediately",
				lastActivityAt: 2_000,
				sessionHeadVersion: 7,
			},
			{
				summaryRevision: 3,
				title: "Renamed immediately",
				lastActivityAt: 2_000,
				sessionHeadVersion: 7,
			},
		]);
		for (const summary of writes) {
			expect(summary).not.toHaveProperty("content");
			expect(summary).not.toHaveProperty("messages");
		}
	});

	it("rebases once when Relay already accepted a newer summary revision", async () => {
		const revisions: number[] = [];
		const publisher = await Effect.runPromise(
			makeCloudRuntimeSummaryPublisher({
				now: Effect.succeed(1_000),
				read: Effect.succeed({
					title: "Preserved runtime",
					lastActivityAt: 1_000,
					sessionHeadVersion: 9,
				}),
				write: (summary) =>
					Effect.sync(() => {
						revisions.push(summary.summaryRevision);
						return summary.summaryRevision === 1
							? { applied: false, summaryRevision: 12 }
							: { applied: true, summaryRevision: summary.summaryRevision };
					}),
			}),
		);

		expect(await Effect.runPromise(publisher.publish("initial"))).toBe(true);
		expect(revisions).toEqual([1, 13]);
	});

	it("announces readiness when a preserved runtime reconnects", () => {
		expect(runtimeReadyPhaseOnGatewayOpen(false)).toBeNull();
		expect(runtimeReadyPhaseOnGatewayOpen(true)).toBe("repository-ready");
	});

	it("buffers the localhost RPC handshake only within a bounded handoff", () => {
		const queue = { frames: [] as Array<string | ArrayBuffer>, bytes: 0 };
		expect(bufferWorkspaceLocalFrame(queue, "handshake")).toBe(true);
		expect(
			bufferWorkspaceLocalFrame(queue, new Uint8Array([1, 2]).buffer),
		).toBe(true);
		expect(queue.frames).toEqual(["handshake", new Uint8Array([1, 2]).buffer]);
		expect(queue.bytes).toBe(11);
		expect(bufferWorkspaceLocalFrame(queue, new ArrayBuffer(256 * 1024))).toBe(
			false,
		);
		expect(queue.frames).toHaveLength(2);
	});

	it("renews a runtime credential at half-life", () => {
		expect(runtimeCredentialRenewalDelayMs(115_000, 100_000)).toBe(7_500);
		expect(runtimeCredentialRenewalDelayMs(99_000, 100_000)).toBe(0);
	});

	it("binds renewal proof to the runtime generation and gateway epoch", async () => {
		const keys = await generateKeyPair("EdDSA", { extractable: true });
		const proof = await Effect.runPromise(
			signRuntimeRenewalProof({
				privateKey: keys.privateKey,
				relayIssuer: "https://relay.example.test",
				workspaceId: "workspace-1",
				requestId: "renewal-1",
				generation: 4,
				gatewayEpoch: 7,
				nowMs: 100_000,
			}),
		);
		const verified = await jwtVerify(proof, keys.publicKey, {
			audience: "https://relay.example.test",
			typ: "workspace-runtime-renewal+jwt",
			currentDate: new Date(100_000),
		});
		expect(verified.payload).toMatchObject({
			workspaceId: "workspace-1",
			requestId: "renewal-1",
			generation: 4,
			gatewayEpoch: 7,
		});
	});

	it("retries a transient enrollment failure instead of leaving the runtime detached", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const attemptCount = yield* Ref.make(0);
				const bootstrap = Ref.updateAndGet(
					attemptCount,
					(count) => count + 1,
				).pipe(
					Effect.flatMap((attempt) =>
						attempt === 1
							? Effect.fail(new Error("relay_401"))
							: Effect.succeed("connected"),
					),
				);
				const fiber = yield* Effect.forkDetach(
					retryCloudWorkspaceBootstrap(bootstrap),
				);

				yield* Effect.yieldNow;
				expect(yield* Ref.get(attemptCount)).toBe(1);

				yield* TestClock.adjust("1 second");
				expect(yield* Fiber.join(fiber)).toBe("connected");
				expect(yield* Ref.get(attemptCount)).toBe(2);
			}).pipe(Effect.provide(TestClock.layer())),
		);
	});

	it("replays a launch intent with one stable domain command and turn", async () => {
		const createChat = vi.fn(() =>
			Effect.succeed({
				chat: {} as never,
				initialSession: {} as never,
				initialMessage: null,
			}),
		);
		const workspaces = {
			list: () =>
				Effect.succeed([{ id: "folder-1", path: "/home/zuse/workspace" }]),
			add: vi.fn(),
		} as never;
		const chats = { createChat } as never;
		const launchIntent = {
			commandId: "launch:workspace-1",
			turnId: "turn:workspace-1",
			title: "Durable launch",
			agent: "codex",
			model: "gpt-5",
			permissions: [],
			firstMessage: "finish while the laptop is closed",
		};

		const start = () =>
			Effect.runPromise(
				startCloudWorkspaceLaunchIntent({
					workspaces,
					chats,
					chatId: "chat-1",
					sessionId: "session-1",
					launchIntent,
				}),
			);
		await start();
		// The first acknowledgement can disappear between runtime and Relay. A
		// repeated encrypted intent must carry exactly the same durable identities.
		await start();

		expect(createChat).toHaveBeenCalledTimes(2);
		expect(createChat).toHaveBeenCalledWith(
			expect.objectContaining({
				chatId: "chat-1",
				initialSessionId: "session-1",
				commandId: "launch:workspace-1",
				initialTurnId: "turn:workspace-1",
				initialMessageId: "launch:workspace-1:message",
				initialPrompt: "finish while the laptop is closed",
			}),
		);
	});
});
