import {
	AgentTurnId,
	Message,
	MessageId,
	QueueState,
	SessionId,
	SessionTimelineProjection,
	type SessionTimelineFrame,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	emptySessionTimelineState,
	reduceSessionTimelineFrame,
	SessionTimelineRegistry,
} from "../../src/session-timeline.ts";

const sessionId = SessionId.make("session-1");
const turnId = AgentTurnId.make("turn-1");
const projection = SessionTimelineProjection.make({
	messages: [],
	status: "running",
	currentTurn: { turnId, phase: "running" },
	queue: QueueState.make({ items: [], paused: false }),
	permissionMode: "default",
	runtimeMode: "approval-required",
});

describe("session timeline reducer", () => {
	it("commits projection and cursor atomically before render notification", () => {
		const snap = reduceSessionTimelineFrame(emptySessionTimelineState(), {
			kind: "snapshot",
			sessionId,
			throughVersion: 4,
			projection,
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
			eventId: "event-5",
			event: { _tag: "MessagePersisted", message },
		});

		expect(next.appliedVersion).toBe(5);
		expect(next.projection?.messages).toEqual([message]);
	});

	it("requires the explicit synchronization barrier before becoming live", () => {
		const snap = reduceSessionTimelineFrame(emptySessionTimelineState(), {
			kind: "snapshot",
			sessionId,
			throughVersion: 4,
			projection,
		});
		expect(snap.phase).toBe("synchronizing");

		const live = reduceSessionTimelineFrame(snap, {
			kind: "synchronized",
			sessionId,
			throughVersion: 4,
		});
		expect(live.phase).toBe("live");
	});

	it("rejects gaps without advancing past missing durable state", () => {
		const snap = reduceSessionTimelineFrame(emptySessionTimelineState(), {
			kind: "snapshot",
			sessionId,
			throughVersion: 4,
			projection,
		});
		const next = reduceSessionTimelineFrame(snap, {
			kind: "event",
			sessionId,
			streamVersion: 6,
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
		});
		const duplicate: SessionTimelineFrame = {
			kind: "event",
			sessionId,
			streamVersion: 4,
			eventId: "event-4",
			event: { _tag: "Noop" },
		};
		expect(reduceSessionTimelineFrame(snap, duplicate)).toBe(snap);
	});

	it("keeps rapid A to B to A projections and cursors independently", () => {
		const registry = new SessionTimelineRegistry(10_000);
		const sessionA = SessionId.make("session-a");
		const sessionB = SessionId.make("session-b");
		registry.accept(sessionA, {
			kind: "snapshot",
			sessionId: sessionA,
			throughVersion: 4,
			projection,
		});
		registry.accept(sessionB, {
			kind: "snapshot",
			sessionId: sessionB,
			throughVersion: 9,
			projection: SessionTimelineProjection.make({ ...projection, messages: [] }),
		});
		registry.accept(sessionA, {
			kind: "event",
			sessionId: sessionA,
			streamVersion: 5,
			eventId: "a-5",
			event: { _tag: "Noop" },
		});

		expect(registry.state(sessionA).appliedVersion).toBe(5);
		expect(registry.state(sessionB).appliedVersion).toBe(9);
		registry.shutdown();
	});
});
