import { describe, expect, it, vi } from "vitest";

import {
	getPowerRuntimeActivity,
	reportPowerBrowserRecordingStarted,
	reportPowerBrowserRecordingStopped,
	reportPowerBrowserSession,
	setPowerActiveTerminalCount,
	setPowerIndexing,
	subscribePowerRuntimeActivity,
} from "../../src/lib/power-runtime-activity.ts";

describe("power runtime activity", () => {
	it("publishes lightweight workload counts and cleans up subscriptions", () => {
		const listener = vi.fn();
		const unsubscribe = subscribePowerRuntimeActivity(listener);

		setPowerActiveTerminalCount(2);
		reportPowerBrowserSession("one", true);
		reportPowerBrowserSession("two", false);
		reportPowerBrowserRecordingStarted();
		setPowerIndexing(true);

		expect(getPowerRuntimeActivity()).toEqual({
			activeTerminals: 2,
			browserSessions: 2,
			activeBrowserSessions: 1,
			browserRecordings: 1,
			indexing: true,
		});
		expect(listener).toHaveBeenCalledTimes(5);

		unsubscribe();
		reportPowerBrowserSession("one", null);
		reportPowerBrowserSession("two", null);
		reportPowerBrowserRecordingStopped();
		setPowerIndexing(false);
		setPowerActiveTerminalCount(0);

		expect(listener).toHaveBeenCalledTimes(5);
	});

	it("never reports negative counts", () => {
		reportPowerBrowserRecordingStopped();
		setPowerActiveTerminalCount(-1);

		expect(getPowerRuntimeActivity()).toEqual({
			activeTerminals: 0,
			browserSessions: 0,
			activeBrowserSessions: 0,
			browserRecordings: 0,
			indexing: false,
		});
	});
});
