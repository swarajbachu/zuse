import { describe, expect, it } from "vitest";

import {
	canShowChatTurnNavigator,
	resolveChatTurnListHeight,
} from "../../src/lib/chat-turn-navigator-layout.ts";

describe("chat turn navigator layout", () => {
	it("hides when the transcript has no safe corner space", () => {
		expect(canShowChatTurnNavigator({ width: 639, height: 900 })).toBe(false);
		expect(canShowChatTurnNavigator({ width: 900, height: 383 })).toBe(false);
	});

	it("shows in a sufficiently large transcript viewport", () => {
		expect(canShowChatTurnNavigator({ width: 640, height: 384 })).toBe(true);
	});

	it("includes list padding without exceeding the overflow cap", () => {
		expect(
			resolveChatTurnListHeight({
				turnCount: 2,
				rowHeight: 32,
				maxHeight: 320,
			}),
		).toBe(72);
		expect(
			resolveChatTurnListHeight({
				turnCount: 20,
				rowHeight: 32,
				maxHeight: 320,
			}),
		).toBe(320);
	});
});
