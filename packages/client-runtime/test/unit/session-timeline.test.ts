import {
	AgentTurnId,
	EnvironmentId,
	Message,
	MessageId,
	QueueState,
	SessionId,
	type SessionTimelineFrame,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	emptySessionTimelineState,
	observeOptimisticTimelineProjection,
	prependSessionTimelineMessages,
	reduceSessionTimelineFrame,
} from "../../src/session-timeline.ts";
import {
	decodeSessionTimelineCacheEntry,
	encodeSessionTimelineCacheEntry,
	makeSessionTimelineCacheEntry,
} from "../../src/session-timeline-cache.ts";

const sessionId = SessionId.make("session-1");
const turnId = AgentTurnId.make("turn-1");
const cursor = (epoch: string, version: number) => ({ epoch, version });
const projection = SessionTimelineProjection.make({
	messages: [],
	status: "running",
	currentTurn: { turnId, phase: "running" },
	queue: QueueState.make({ items: [], paused: false }),
	permissionMode: "default",
	runtimeMode: "approval-required",
});

describe("session timeline reducer", () => {
	it("retains the first optimistic prompt until its durable snapshot arrives", () => {
		const optimistic = Message.make({
			id: MessageId.make("message-optimistic"),
			sessionId,
			role: "user",
			content: { _tag: "user", text: "hello immediately" },
			createdAt: new Date(1),
		});
		const observed = observeOptimisticTimelineProjection(
			emptySessionTimelineState(),
			SessionTimelineProjection.make({
				...projection,
				messages: [optimistic],
			}),
		);
		const beforeAck = reduceSessionTimelineFrame(observed, {
			kind: "snapshot",
			sessionId,
			throughVersion: 0,
			cursor: cursor("epoch-a", 0),
			projection: SessionTimelineProjection.make({
				...projection,
				messages: [],
			}),
		});
		expect(beforeAck.projection?.messages).toEqual([optimistic]);

		const durable = reduceSessionTimelineFrame(beforeAck, {
			kind: "event",
			sessionId,
			streamVersion: 1,
			cursor: cursor("epoch-a", 1),
			eventId: "event-1",
			event: { _tag: "MessagePersisted", message: optimistic },
		});
		expect(durable.projection?.messages).toEqual([optimistic]);
		expect(durable.optimistic.messages).toEqual({});
	});

	it("prepends older messages with stable dedupe and no stream cursor regression", () => {
		const existing = Message.make({
			id: MessageId.make("message-existing"),
			sessionId,
			role: "assistant",
			content: { _tag: "assistant", text: "newer durable value" },
			createdAt: new Date(2),
		});
		const older = Message.make({
			id: MessageId.make("message-older"),
			sessionId,
			role: "user",
			content: { _tag: "user", text: "older" },
			createdAt: new Date(1),
		});
		const staleDuplicate = Message.make({
			...existing,
			content: { _tag: "assistant", text: "stale paged value" },
		});
		const state = reduceSessionTimelineFrame(emptySessionTimelineState(), {
			kind: "snapshot",
			sessionId,
			throughVersion: 9,
			cursor: cursor("epoch-a", 9),
			olderMessageSequence: 20,
			projection: SessionTimelineProjection.make({
				...projection,
				messages: [existing],
			}),
		});
		expect(state.projection?.olderMessageSequence).toBe(20);

		const next = prependSessionTimelineMessages(
			state,
			[older, staleDuplicate],
			null,
		);
		expect(next.projection?.messages).toEqual([older, existing]);
		expect(next.projection?.olderMessageSequence).toBeNull();
		expect(next.cursor).toEqual(cursor("epoch-a", 9));
		expect(next.appliedVersion).toBe(9);
	});

	it("commits projection and cursor atomically before render notification", () => {
		const snap = reduceSessionTimelineFrame(emptySessionTimelineState(), {
			kind: "snapshot",
			sessionId,
			throughVersion: 4,
			projection,
			cursor: cursor("epoch-a", 4),
		});
		const message = Message.make({
			id: MessageId.make("message-1"),
			sessionId,
			role: "assistant",
			content: { _tag: "assistant", text: "hello" },
			createdAt: new Date(1),
		});
		const next = reduceSessionTimelineFrame(snap, {
			kind: "event",
			sessionId,
			streamVersion: 5,
			cursor: cursor("epoch-a", 5),
			eventId: "event-5",
			event: { _tag: "MessagePersisted", message },
		});

		expect(next.appliedVersion).toBe(5);
		expect(next.cursor).toEqual(cursor("epoch-a", 5));
		expect(next.projection?.messages).toEqual([message]);
	});

	it("requires the explicit synchronization barrier before becoming live", () => {
		const snap = reduceSessionTimelineFrame(emptySessionTimelineState(), {
			kind: "snapshot",
			sessionId,
			throughVersion: 4,
			projection,
			cursor: cursor("epoch-a", 4),
		});
		expect(snap.phase).toBe("synchronizing");

		const live = reduceSessionTimelineFrame(snap, {
			kind: "synchronized",
			sessionId,
			throughVersion: 4,
			cursor: cursor("epoch-a", 4),
		});
		expect(live.phase).toBe("live");
	});

	it("rejects gaps without advancing past missing durable state", () => {
		const snap = reduceSessionTimelineFrame(emptySessionTimelineState(), {
			kind: "snapshot",
			sessionId,
			throughVersion: 4,
			projection,
			cursor: cursor("epoch-a", 4),
		});
		const next = reduceSessionTimelineFrame(snap, {
			kind: "event",
			sessionId,
			streamVersion: 6,
			cursor: cursor("epoch-a", 6),
			eventId: "event-6",
			event: { _tag: "Noop" },
		});

		expect(next.appliedVersion).toBe(4);
		expect(next.phase).toBe("stale");
		expect(next.error).toMatch(/expected version 5/i);
	});

	it("ignores replay/live duplicates", () => {
		const snap = reduceSessionTimelineFrame(emptySessionTimelineState(), {
			kind: "snapshot",
			sessionId,
			throughVersion: 4,
			projection,
			cursor: cursor("epoch-a", 4),
		});
		const duplicate: SessionTimelineFrame = {
			kind: "event",
			sessionId,
			streamVersion: 4,
			cursor: cursor("epoch-a", 4),
			eventId: "event-4",
			event: { _tag: "Noop" },
		};
		expect(reduceSessionTimelineFrame(snap, duplicate)).toBe(snap);
	});

	it("retains cached data across an epoch reset and accepts its bounded snapshot", () => {
		const beforeReset = reduceSessionTimelineFrame(
			reduceSessionTimelineFrame(emptySessionTimelineState(), {
				kind: "snapshot",
				sessionId,
				throughVersion: 4,
				cursor: cursor("epoch-a", 4),
				projection,
			}),
			{
				kind: "synchronized",
				sessionId,
				throughVersion: 4,
				cursor: cursor("epoch-a", 4),
			},
		);
		const resetting = reduceSessionTimelineFrame(beforeReset, {
			kind: "reset-required",
			sessionId,
			throughVersion: 12,
			cursor: cursor("epoch-b", 12),
			reason: "restored",
		});

		expect(resetting).toMatchObject({
			projection,
			cursor: cursor("epoch-a", 4),
			resetEpoch: "epoch-b",
			phase: "synchronizing",
			error: null,
		});

		const resetSnapshot = reduceSessionTimelineFrame(resetting, {
			kind: "snapshot",
			sessionId,
			throughVersion: 12,
			cursor: cursor("epoch-b", 12),
			projection,
		});
		expect(resetSnapshot).toMatchObject({
			cursor: cursor("epoch-b", 12),
			resetEpoch: null,
			appliedVersion: 12,
			phase: "synchronizing",
			error: null,
		});
		expect(
			reduceSessionTimelineFrame(resetSnapshot, {
				kind: "synchronized",
				sessionId,
				throughVersion: 12,
				cursor: cursor("epoch-b", 12),
			}).phase,
		).toBe("live");
	});

	it("accepts a cursor-invalid reset when a same-epoch cache is ahead of the runtime", () => {
		const cached = reduceSessionTimelineFrame(emptySessionTimelineState(), {
			kind: "snapshot",
			sessionId,
			throughVersion: 12,
			cursor: cursor("epoch-a", 12),
			projection,
		});
		const resetting = reduceSessionTimelineFrame(cached, {
			kind: "reset-required",
			sessionId,
			throughVersion: 3,
			cursor: cursor("epoch-a", 3),
			reason: "cursor-invalid",
		});

		expect(resetting).toMatchObject({
			projection,
			cursor: cursor("epoch-a", 12),
			resetEpoch: "epoch-a",
			phase: "synchronizing",
		});
		const resetSnapshot = reduceSessionTimelineFrame(resetting, {
			kind: "snapshot",
			sessionId,
			throughVersion: 3,
			cursor: cursor("epoch-a", 3),
			projection: SessionTimelineProjection.make({
				...projection,
				status: "idle",
				currentTurn: null,
			}),
		});
		expect(resetSnapshot).toMatchObject({
			cursor: cursor("epoch-a", 3),
			resetEpoch: null,
			phase: "synchronizing",
			projection: { status: "idle", currentTurn: null },
		});
	});

	it("handles repeated reconnect and reset frames without regressing durable state", () => {
		const live = reduceSessionTimelineFrame(
			reduceSessionTimelineFrame(emptySessionTimelineState(), {
				kind: "snapshot",
				sessionId,
				throughVersion: 7,
				cursor: cursor("epoch-a", 7),
				projection,
			}),
			{
				kind: "synchronized",
				sessionId,
				throughVersion: 7,
				cursor: cursor("epoch-a", 7),
			},
		);
		const duplicateBarrier = reduceSessionTimelineFrame(live, {
			kind: "synchronized",
			sessionId,
			throughVersion: 7,
			cursor: cursor("epoch-a", 7),
		});
		expect(duplicateBarrier).toMatchObject({
			projection,
			cursor: cursor("epoch-a", 7),
			phase: "live",
		});

		const reset = {
			kind: "reset-required" as const,
			sessionId,
			throughVersion: 3,
			cursor: cursor("epoch-b", 3),
			reason: "restored" as const,
		};
		const firstReset = reduceSessionTimelineFrame(duplicateBarrier, reset);
		const repeatedReset = reduceSessionTimelineFrame(firstReset, reset);
		expect(reduceSessionTimelineFrame(duplicateBarrier, reset)).not.toBe(
			duplicateBarrier,
		);
		expect(repeatedReset).toMatchObject({
			projection,
			cursor: cursor("epoch-a", 7),
			resetEpoch: "epoch-b",
			phase: "synchronizing",
		});

		const resetSnapshot = reduceSessionTimelineFrame(repeatedReset, {
			kind: "snapshot",
			sessionId,
			throughVersion: 3,
			cursor: cursor("epoch-b", 3),
			projection: SessionTimelineProjection.make({
				...projection,
				status: "idle",
				currentTurn: null,
			}),
		});
		const resetLive = reduceSessionTimelineFrame(resetSnapshot, {
			kind: "synchronized",
			sessionId,
			throughVersion: 3,
			cursor: cursor("epoch-b", 3),
		});
		const lateOldSnapshot = reduceSessionTimelineFrame(resetLive, {
			kind: "snapshot",
			sessionId,
			throughVersion: 7,
			cursor: cursor("epoch-a", 7),
			projection,
		});

		expect(resetLive).toMatchObject({
			cursor: cursor("epoch-b", 3),
			phase: "live",
			projection: { status: "idle", currentTurn: null },
		});
		expect(lateOldSnapshot).toMatchObject({
			cursor: cursor("epoch-b", 3),
			phase: "stale",
			projection: { status: "idle", currentTurn: null },
		});
		expect(lateOldSnapshot.error).toMatch(/changed epoch/i);
	});

	it("rejects an event from another epoch until reset is explicit", () => {
		const state = reduceSessionTimelineFrame(emptySessionTimelineState(), {
			kind: "snapshot",
			sessionId,
			throughVersion: 4,
			cursor: cursor("epoch-a", 4),
			projection,
		});
		const next = reduceSessionTimelineFrame(state, {
			kind: "event",
			sessionId,
			streamVersion: 5,
			cursor: cursor("epoch-b", 5),
			eventId: "wrong-epoch",
			event: { _tag: "Noop" },
		});

		expect(next.cursor).toEqual(cursor("epoch-a", 4));
		expect(next.phase).toBe("stale");
		expect(next.error).toMatch(/changed epoch/i);
	});
});

describe("session timeline cache", () => {
	it("round-trips the full projection with dates intact", () => {
		const message = Message.make({
			id: MessageId.make("cached-message"),
			sessionId,
			role: "assistant",
			content: { _tag: "assistant", text: "cached" },
			createdAt: new Date("2026-07-25T00:00:00.000Z"),
		});
		const entry = makeSessionTimelineCacheEntry({
			ref: { environmentId: EnvironmentId.make("local"), sessionId },
			cursor: cursor("epoch-cache", 8),
			projection: SessionTimelineProjection.make({
				...projection,
				currentTurn: null,
				messages: [message],
			}),
			now: 42,
		});

		const decoded = decodeSessionTimelineCacheEntry(
			encodeSessionTimelineCacheEntry(entry),
		);

		expect(decoded.cursor).toEqual(cursor("epoch-cache", 8));
		expect(decoded.ref).toEqual({ environmentId: "local", sessionId });
		expect(decoded.projection.messages[0]?.createdAt).toEqual(
			message.createdAt,
		);
		expect(decoded.savedAt).toBe(42);
	});

	it("upgrades an environment-qualified v2 entry with a legacy epoch", () => {
		const decoded = decodeSessionTimelineCacheEntry({
			schemaVersion: 2,
			sessionId: "session:local:session-1",
			ref: { environmentId: "local", sessionId },
			appliedVersion: 7,
			projection,
			savedAt: 40,
			accessedAt: 41,
			estimatedBytes: 42,
		});

		expect(decoded.schemaVersion).toBe(3);
		expect(decoded.cursor).toEqual(cursor("legacy", 7));
		expect(decoded.ref).toEqual({ environmentId: "local", sessionId });
	});

	it("rejects entries from an unsupported schema", () => {
		expect(() =>
			decodeSessionTimelineCacheEntry({
				schemaVersion: 0,
				sessionId,
			}),
		).toThrow();
	});
});
