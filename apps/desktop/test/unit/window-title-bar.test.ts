import { describe, expect, it } from "vitest";

import {
	createTitleBarOverlay,
	createWindowTitleBarOptions,
	WINDOW_TITLE_BAR_HEIGHT,
} from "../../src/window-title-bar.ts";

describe("desktop window title bar", () => {
	it("keeps macOS inset traffic lights", () => {
		expect(createWindowTitleBarOptions("darwin", true)).toEqual({
			autoHideMenuBar: false,
			titleBarStyle: "hiddenInset",
		});
	});

	it.each([
		"linux",
		"win32",
	] as const)("uses the renderer title bar with native controls on %s", (platform) => {
		expect(createWindowTitleBarOptions(platform, true)).toEqual({
			autoHideMenuBar: true,
			titleBarOverlay: {
				color: "#0b0b0c",
				height: WINDOW_TITLE_BAR_HEIGHT,
				symbolColor: "#a1a1aa",
			},
			titleBarStyle: "hidden",
		});
	});

	it("keeps overlay colors legible in light mode", () => {
		expect(createTitleBarOverlay(false)).toMatchObject({
			color: "#fafafa",
			symbolColor: "#52525b",
		});
	});
});
