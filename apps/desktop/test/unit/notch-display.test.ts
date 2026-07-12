import { describe, expect, it } from "vitest";

import {
	detectNotchDisplaySupport,
	findNotchedDisplay,
	isLikelyNotchedMacBookDisplay,
	type NotchDisplayLike,
} from "../../src/notch-display.ts";

const display = (
	width: number,
	height: number,
	scaleFactor = 2,
	internal = true,
): NotchDisplayLike => ({
	bounds: { width, height },
	scaleFactor,
	internal,
});

describe("notch display detection", () => {
	it("detects a likely notched MacBook built-in display", () => {
		expect(isLikelyNotchedMacBookDisplay(display(1512, 982))).toBe(true);
		expect(isLikelyNotchedMacBookDisplay(display(3024, 1964))).toBe(true);
		expect(detectNotchDisplaySupport("darwin", [display(1512, 982)])).toEqual({
			supported: true,
			reason: "supported",
		});
	});

	it("rejects external displays with matching dimensions", () => {
		expect(isLikelyNotchedMacBookDisplay(display(1512, 982, 2, false))).toBe(
			false,
		);
		expect(
			detectNotchDisplaySupport("darwin", [display(1512, 982, 2, false)]),
		).toEqual({ supported: false, reason: "no-notched-display" });
	});

	it("rejects non-macOS platforms", () => {
		expect(detectNotchDisplaySupport("linux", [display(1512, 982)])).toEqual({
			supported: false,
			reason: "not-macos",
		});
	});

	it("returns the first supported display", () => {
		const notched = display(1728, 1117);
		expect(findNotchedDisplay("darwin", [display(1920, 1080), notched])).toBe(
			notched,
		);
	});
});
