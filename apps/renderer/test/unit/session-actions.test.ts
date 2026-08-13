import { describe, expect, it } from "vitest";

import {
	classifyMessage,
	queuedMessageShouldFlush,
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

	it("does not flush a held queue item before its startup context is ready", () => {
		expect(queuedMessageShouldFlush()).toBe(true);
		expect(queuedMessageShouldFlush({ flush: true })).toBe(true);
		expect(queuedMessageShouldFlush({ flush: false })).toBe(false);
	});
});
