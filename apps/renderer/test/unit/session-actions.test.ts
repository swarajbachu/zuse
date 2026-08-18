import {
	ComposerInput,
	EnvironmentId,
	QueuedMessage,
	QueuedMessageNotFoundError,
	QueueState,
	SessionId,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { Effect, Queue, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
	classifyMessage,
	isRecoveredPreAckSessionError,
	optimisticQueuedMessageReady,
	pendingSessionCommandError,
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

	it("classifies reconnect failures without clearing canonical data", () => {
		expect(
			classifyMessage("WebSocket closed while the laptop was offline"),
		).toEqual({
			kind: "network",
			message: "WebSocket closed while the laptop was offline",
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
});
