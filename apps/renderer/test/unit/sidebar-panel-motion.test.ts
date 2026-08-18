import { describe, expect, it } from "vitest";
import { shouldAnimateSidebarVisibility } from "../../src/lib/sidebar-panel-motion.ts";

describe("shouldAnimateSidebarVisibility", () => {
	it("animates visibility changes within the same sidebar context", () => {
		expect(
			shouldAnimateSidebarVisibility(
				{ contextKey: "chat-a", open: false },
				{ contextKey: "chat-a", open: true },
			),
		).toBe(true);
	});

	it("does not animate visibility changes caused by switching tabs", () => {
		expect(
			shouldAnimateSidebarVisibility(
				{ contextKey: "chat-a", open: false },
				{ contextKey: "chat-b", open: true },
			),
		).toBe(false);
	});

	it("does not animate initial sidebar synchronization", () => {
		expect(
			shouldAnimateSidebarVisibility(undefined, {
				contextKey: "chat-a",
				open: true,
			}),
		).toBe(false);
	});
});
