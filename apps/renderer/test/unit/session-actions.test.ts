import { CloudCommandTerminalError } from "@zuse/client-runtime/client-persistence";
import {
	ComposerInput,
	EnvironmentId,
	QueuedMessage,
	QueuedMessageNotFoundError,
	QueueState,
	SessionId,
	SessionNotFoundError,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { Effect, Queue, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
	classifyError,
	classifyMessage,
	isRecoveredPreAckSessionError,
	optimisticQueuedMessageReady,
	pendingSessionCommandError,
	persistQueuedMessage,
	queueSessionMessage,
	sendSessionMessage,
	updateQueuedMessage,
} from "../../src/lib/session-actions.ts";
import {
	getRendererClientBus,
	resetSessionTimelineClientBusForTest,
	retainSessionTimeline,
	setSessionTimelineRpcClientForTest,
} from "../../src/lib/session-timeline-client-bus.ts";

const waitUntil = async (predicate: () => boolean): Promise<void> => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not reached");
};

const environmentId = EnvironmentId.make("session-actions-environment");
const sessionId = SessionId.make("session-actions-session");
const ref = { environmentId, sessionId } as const;

describe("session actions", () => {
	afterEach(() => {
		resetSessionTimelineClientBusForTest();
	});

	it("classifies provider authentication failures once at the boundary", () => {
		expect(classifyMessage("401 unauthorized", "codex")).toEqual({
			kind: "auth",
			providerId: "codex",
			message: "401 unauthorized",
		});
	});

	it("classifies broker reconnects as Codex authentication", () => {
		expect(classifyMessage("codex-auth-reconnect-required", "codex")).toEqual({
			kind: "auth",
			providerId: "codex",
			message: "codex-auth-reconnect-required",
		});
	});

	it("classifies reconnect failures without clearing canonical data", () => {
		expect(
			classifyMessage("WebSocket closed while the laptop was offline"),
		).toEqual({
			kind: "network",
			message: "WebSocket closed while the laptop was offline",
		});
	});

	it("classifies terminal cloud lifecycle failures without exposing internals", () => {
		expect(
			classifyError(
				new CloudCommandTerminalError(
					"cancelled",
					"workspace-deleted",
					"This workspace was archived or deleted before the command was accepted.",
				),
			),
		).toEqual({
			kind: "terminal",
			category: "workspace-deleted",
			headline: "Workspace unavailable",
			message:
				"This workspace was archived or deleted before the command could finish.",
		});
	});

	it("presents Codex authentication and missing sessions as typed actions", () => {
		expect(
			classifyMessage("codex: Auth(AuthorizationRequired)", "codex"),
		).toEqual({
			kind: "auth",
			providerId: "codex",
			message: "codex: Auth(AuthorizationRequired)",
		});
		expect(classifyError(new SessionNotFoundError({ sessionId }))).toEqual({
			kind: "terminal",
			category: "session-unavailable",
			headline: "Session unavailable",
			message: "This chat session is no longer available in the agent runtime.",
		});
	});

	it("does not expose a queued message as runnable before its add receipt", () => {
		expect(optimisticQueuedMessageReady()).toBe(false);
		expect(optimisticQueuedMessageReady({ ready: true })).toBe(false);
		expect(optimisticQueuedMessageReady({ persist: false })).toBe(true);
		expect(optimisticQueuedMessageReady({ persist: false, ready: false })).toBe(
			false,
		);
	});

	it("drops a provisional session-not-found error after the timeline is live", () => {
		expect(
			isRecoveredPreAckSessionError("SessionNotFoundError", {
				data: {},
				sync: "live",
			}),
		).toBe(true);
		expect(
			isRecoveredPreAckSessionError("SessionNotFoundError", {
				data: null,
				sync: "synchronizing",
			}),
		).toBe(false);
		expect(
			isRecoveredPreAckSessionError("actual provider failure", {
				data: {},
				sync: "live",
			}),
		).toBe(false);
	});

	it("keeps the composer submission unaccepted after a retryable transport failure", async () => {
		const frames = Effect.runSync(Queue.unbounded());
		let streamStarts = 0;
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"session.events": () => {
						streamStarts += 1;
						return Stream.fromQueue(frames);
					},
					"messages.send": () =>
						Effect.fail({
							_tag: "RpcClientError",
							reason: { _tag: "SocketError", message: "offline" },
						}),
				}) as never,
		);

		const retained = retainSessionTimeline(ref, "connect");
		await waitUntil(() => streamStarts === 1);
		await expect(sendSessionMessage(ref, "keep this draft")).resolves.toBe(
			false,
		);

		const view = getRendererClientBus().snapshot(retained.key);
		expect(view.data?.messages).toHaveLength(1);
		expect(view.data?.messages[0]?.content).toMatchObject({
			_tag: "user",
			text: "keep this draft",
		});
		expect(view.failedCommands).toHaveLength(1);
		expect(view.failedCommands[0]?.retryable).toBe(true);
		retained.lease.release();
	});

	it("converges when a queued message was consumed before its final update", async () => {
		const frames = Effect.runSync(Queue.unbounded());
		let streamStarts = 0;
		const input = ComposerInput.make({
			text: "make pr",
			attachments: [],
			fileRefs: [],
			skillRefs: [],
		});
		const queueId = "queue-consumed-before-update";
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"session.events": () => {
						streamStarts += 1;
						return Stream.fromQueue(frames);
					},
					"messages.queue.update": () =>
						Effect.fail(new QueuedMessageNotFoundError({ sessionId, queueId })),
				}) as never,
		);

		const retained = retainSessionTimeline(ref, "connect");
		await waitUntil(() => streamStarts === 1);
		Queue.offerUnsafe(frames, {
			kind: "snapshot",
			sessionId,
			throughVersion: 0,
			cursor: { epoch: "queue-epoch", version: 0 },
			projection: SessionTimelineProjection.make({
				messages: [],
				status: "idle",
				currentTurn: null,
				queue: QueueState.make({
					items: [
						QueuedMessage.make({
							id: queueId,
							sessionId,
							input,
							position: 0,
							createdAt: new Date(),
							updatedAt: new Date(),
							ready: false,
						}),
					],
					paused: false,
				}),
				permissionMode: "default",
				runtimeMode: "approval-required",
			}),
		});
		await waitUntil(
			() =>
				getRendererClientBus().snapshot(retained.key).data?.queue.items
					.length === 1,
		);

		await updateQueuedMessage(ref, queueId, input);

		expect(
			getRendererClientBus().snapshot(retained.key).data?.queue.items,
		).toEqual([]);
		expect(
			getRendererClientBus().snapshot(retained.key).failedCommands,
		).toEqual([]);
		expect(pendingSessionCommandError(ref)).toBeNull();
		retained.lease.release();
	});

	it("removes an optimistic queue row after an authoritative add rejection", async () => {
		const frames = Effect.runSync(Queue.unbounded());
		let streamStarts = 0;
		const input = ComposerInput.make({
			text: "deliver after resume",
			attachments: [],
			fileRefs: [],
			skillRefs: [],
		});
		const queueId = "queue-missing-runtime-session";
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"session.events": () => {
						streamStarts += 1;
						return Stream.fromQueue(frames);
					},
					"messages.queue.add": () =>
						Effect.fail(new SessionNotFoundError({ sessionId })),
				}) as never,
		);

		const retained = retainSessionTimeline(ref, "connect");
		await waitUntil(() => streamStarts === 1);
		Queue.offerUnsafe(frames, {
			kind: "snapshot",
			sessionId,
			throughVersion: 0,
			cursor: { epoch: "queue-epoch", version: 0 },
			projection: SessionTimelineProjection.make({
				messages: [],
				status: "idle",
				currentTurn: null,
				queue: QueueState.make({ items: [], paused: false }),
				permissionMode: "default",
				runtimeMode: "approval-required",
			}),
		});
		await waitUntil(
			() =>
				getRendererClientBus().snapshot(retained.key).data?.queue.items
					.length === 0,
		);
		queueSessionMessage(ref, input, { persist: false, ready: false, queueId });
		expect(
			getRendererClientBus().snapshot(retained.key).data?.queue.items,
		).toHaveLength(1);

		await persistQueuedMessage(ref, queueId, input);

		expect(
			getRendererClientBus().snapshot(retained.key).data?.queue.items,
		).toEqual([]);
		expect(pendingSessionCommandError(ref)).toMatchObject({
			kind: "terminal",
			category: "session-unavailable",
			headline: "Session unavailable",
			message: "This chat session is no longer available in the agent runtime.",
		});
		retained.lease.release();
	});
});
