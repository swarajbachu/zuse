import { CommandId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	effectiveSessionRuntimeState,
	hasPendingTurnStart,
	isSessionRuntimeBusy,
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
