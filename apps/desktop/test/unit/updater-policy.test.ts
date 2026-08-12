import { describe, expect, it } from "vitest";

import {
	shouldAutoInstallUpdateOnQuit,
	shouldInstallPendingUpdateOnQuit,
} from "../../src/updater-policy.ts";

describe("desktop updater policy", () => {
	it("keeps macOS downloads replaceable until the app quits", () => {
		expect(shouldAutoInstallUpdateOnQuit("darwin")).toBe(false);
		expect(shouldAutoInstallUpdateOnQuit("win32")).toBe(true);
		expect(shouldAutoInstallUpdateOnQuit("linux")).toBe(true);
	});

	it("stages a ready macOS update when the user quits", () => {
		expect(
			shouldInstallPendingUpdateOnQuit({
				platform: "darwin",
				status: { kind: "ready", version: "0.18.5" },
				installing: false,
			}),
		).toBe(true);
	});

	it("does not intercept quit without a ready macOS update", () => {
		expect(
			shouldInstallPendingUpdateOnQuit({
				platform: "darwin",
				status: { kind: "downloading", percent: 50, bytesPerSecond: 1_000 },
				installing: false,
			}),
		).toBe(false);
		expect(
			shouldInstallPendingUpdateOnQuit({
				platform: "linux",
				status: { kind: "ready", version: "0.18.5" },
				installing: false,
			}),
		).toBe(false);
		expect(
			shouldInstallPendingUpdateOnQuit({
				platform: "darwin",
				status: { kind: "ready", version: "0.18.5" },
				installing: true,
			}),
		).toBe(false);
	});
});
