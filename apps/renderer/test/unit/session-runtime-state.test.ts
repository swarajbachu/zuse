import { describe, expect, it } from "vitest";
import {
	effectiveSessionRuntimeState,
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
});
