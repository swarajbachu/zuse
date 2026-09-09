import {
	CommandId,
	QueueState,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	effectiveSessionRuntimeState,
	hasPendingTurnStart,
	isSessionRuntimeBusy,
	runtimeStateFromResource,
	runtimeStateFromStatus,
} from "../../src/lib/session-runtime-state.ts";

describe("session runtime state", () => {
	it("treats booting as busy before a running event arrives", () => {
		const state = runtimeStateFromStatus("booting");
		expect(state).toBe("starting");
		expect(isSessionRuntimeBusy(state)).toBe(true);
	});

	it("uses a projector entry instead of recombining mutable facts", () => {
		expect(effectiveSessionRuntimeState("idle")).toBe("idle");
		expect(effectiveSessionRuntimeState(undefined)).toBe("idle");
	});

	it("bridges a submitted prompt until the durable turn starts", () => {
		expect(
			hasPendingTurnStart([
				{
					commandId: CommandId.make("message-send:1"),
					kind: "messages.send",
					submittedAt: 1,
				},
			]),
		).toBe(true);
		expect(
			hasPendingTurnStart([
				{
					commandId: CommandId.make("queue-update:1"),
					kind: "messages.queue.update",
					submittedAt: 1,
				},
			]),
		).toBe(false);
	});
});

describe("runtime freshness", () => {
	const stale = SessionTimelineProjection.make({
		messages: [],
		status: "running",
		currentTurn: null,
		queue: QueueState.make({ items: [], paused: false }),
		permissionMode: "default",
		runtimeMode: "approval-required",
	});
	const view = {
		data: stale,
		origin: "cache" as const,
		connection: "connected" as const,
		sync: "cached" as const,
		generation: 1,
		cursor: null,
		pendingCommands: [],
		failedCommands: [],
	};
	it("uses the current idle session summary over an old running transcript", () => {
		expect(runtimeStateFromResource(view, "idle")).toBe("idle");
	});
	it("does not animate cached running state while disconnected", () => {
		expect(
			runtimeStateFromResource({ ...view, connection: "offline" }, "running"),
		).toBe("idle");
	});
	it("shows fresh running summaries even when the transcript is cached idle", () => {
		expect(
			runtimeStateFromResource(
				{ ...view, data: { ...stale, status: "idle" } },
				"running",
			),
		).toBe("running");
	});
	it("keeps an in-flight interrupt visible while connected", () => {
		expect(
			runtimeStateFromResource(
				{
					...view,
					pendingCommands: [
						{
							commandId: CommandId.make("interrupt:1"),
							kind: "messages.interrupt",
							submittedAt: 1,
						},
					],
				},
				"idle",
			),
		).toBe("stopping");
	});
	it("keeps an authoritative live running turn active", () => {
		expect(
			runtimeStateFromResource(
				{ ...view, sync: "live", origin: "runtime" },
				"idle",
			),
		).toBe("running");
	});
});
