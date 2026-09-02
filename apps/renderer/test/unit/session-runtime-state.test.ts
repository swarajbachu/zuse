import {
	AgentTurnId,
	CommandId,
	QueueState,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	effectiveSessionRuntimeState,
	hasPendingTurnStart,
	isSessionRuntimeBusy,
	runtimeStateFromStatus,
} from "../../src/lib/session-runtime-state.ts";
import { runtimeFromResource } from "../../src/lib/session-timeline-hooks.ts";

describe("session runtime state", () => {
	it("clears a stale running timeline from an authoritative idle summary", () => {
		const projection = SessionTimelineProjection.make({
			messages: [],
			status: "running",
			currentTurn: {
				turnId: AgentTurnId.make("turn-stale-after-disconnect"),
				phase: "running",
			},
			queue: QueueState.make({ items: [], paused: false }),
			permissionMode: "default",
			runtimeMode: "approval-required",
		});

		const view: Parameters<typeof runtimeFromResource>[0] = {
			data: projection,
			origin: "cache",
			connection: "offline",
			sync: "cached",
			generation: 2,
			cursor: { epoch: "stale", version: 4 },
			pendingCommands: [],
			failedCommands: [],
		};
		const runtime = runtimeFromResource(view, "idle");
		expect(runtime).toBe("idle");
		expect(isSessionRuntimeBusy(runtime)).toBe(false);
		expect(runtimeFromResource(view, "failed")).toBe("failed");
	});

	it("keeps pending local commands authoritative while reconnecting", () => {
		expect(
			runtimeFromResource(
				{
					data: null,
					origin: "none",
					connection: "connecting",
					sync: "synchronizing",
					generation: 2,
					cursor: null,
					pendingCommands: [
						{
							commandId: CommandId.make("message-send:reconnecting"),
							kind: "messages.send",
							submittedAt: 1,
						},
					],
					failedCommands: [],
				},
				"idle",
			),
		).toBe("starting");
		expect(
			runtimeFromResource(
				{
					data: null,
					origin: "none",
					connection: "connecting",
					sync: "synchronizing",
					generation: 2,
					cursor: null,
					pendingCommands: [
						{
							commandId: CommandId.make("interrupt:reconnecting"),
							kind: "messages.interrupt",
							submittedAt: 1,
						},
					],
					failedCommands: [],
				},
				"idle",
			),
		).toBe("stopping");
	});

	it("keeps a live timeline authoritative over a lagging idle summary", () => {
		const projection = SessionTimelineProjection.make({
			messages: [],
			status: "running",
			currentTurn: {
				turnId: AgentTurnId.make("turn-live"),
				phase: "running",
			},
			queue: QueueState.make({ items: [], paused: false }),
			permissionMode: "default",
			runtimeMode: "approval-required",
		});

		expect(
			runtimeFromResource(
				{
					data: projection,
					origin: "runtime",
					connection: "connected",
					sync: "live",
					generation: 3,
					cursor: { epoch: "live", version: 5 },
					pendingCommands: [],
					failedCommands: [],
				},
				"idle",
			),
		).toBe("running");
	});

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
