import { describe, expect, it } from "vitest";
import { resolveChatErrorBottom } from "../../src/lib/chat-overlay-position.ts";

describe("resolveChatErrorBottom", () => {
	it("places errors above the measured floating composer", () => {
		expect(resolveChatErrorBottom(296)).toBe(296);
	});

	it("never positions errors below the chat surface", () => {
		expect(resolveChatErrorBottom(-8)).toBe(0);
	});
});
