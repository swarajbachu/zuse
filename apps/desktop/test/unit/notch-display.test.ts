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

	it("detects a 13-inch MacBook Air at default and scaled resolutions", () => {
		expect(isLikelyNotchedMacBookDisplay(display(2560, 1664))).toBe(true);
		expect(isLikelyNotchedMacBookDisplay(display(1280, 832))).toBe(true);
		expect(isLikelyNotchedMacBookDisplay(display(1470, 956))).toBe(true);
		expect(isLikelyNotchedMacBookDisplay(display(1710, 1112))).toBe(true);
	});

	it("detects the Electron Display object from a 13-inch Air M2 on More Space", () => {
		const airM2: NotchDisplayLike = {
			bounds: { width: 1710, height: 1112 },
			size: { width: 1710, height: 1112 },
			scaleFactor: 2,
			internal: true,
		};
		expect(isLikelyNotchedMacBookDisplay(airM2)).toBe(true);
		expect(detectNotchDisplaySupport("darwin", [airM2])).toEqual({
			supported: true,
			reason: "supported",
		});
	});

	it("detects other notched MacBook scaled modes", () => {
		expect(isLikelyNotchedMacBookDisplay(display(2880, 1864))).toBe(true);
		expect(isLikelyNotchedMacBookDisplay(display(1440, 934))).toBe(true);
		expect(isLikelyNotchedMacBookDisplay(display(1800, 1169))).toBe(true);
		expect(isLikelyNotchedMacBookDisplay(display(2056, 1329))).toBe(true);
	});

	it("rejects pre-notch 16:10 built-in MacBooks", () => {
		expect(isLikelyNotchedMacBookDisplay(display(2560, 1600))).toBe(false);
		expect(isLikelyNotchedMacBookDisplay(display(1440, 900))).toBe(false);
	});

	it("rejects 16:9 built-in displays such as iMacs", () => {
		expect(isLikelyNotchedMacBookDisplay(display(4480, 2520))).toBe(false);
		expect(isLikelyNotchedMacBookDisplay(display(1920, 1080))).toBe(false);
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
