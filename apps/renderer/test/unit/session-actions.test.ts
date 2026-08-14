import { describe, expect, it } from "vitest";

import {
	classifyMessage,
	isRecoveredPreAckSessionError,
	optimisticQueuedMessageReady,
} from "../../src/lib/session-actions.ts";

describe("session actions", () => {
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
});
