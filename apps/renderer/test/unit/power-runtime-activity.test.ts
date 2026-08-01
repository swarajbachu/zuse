import { describe, expect, it, vi } from "vitest";

import {
	getPowerRuntimeActivity,
	reportPowerBrowserRecordingStarted,
	reportPowerBrowserRecordingStopped,
	reportPowerBrowserSession,
	setPowerActiveAgentCount,
	setPowerActiveTerminalCount,
	setPowerIndexing,
	subscribePowerRuntimeActivity,
} from "../../src/lib/power-runtime-activity.ts";

describe("power runtime activity", () => {
	it("publishes lightweight workload counts and cleans up subscriptions", () => {
		const listener = vi.fn();
		const unsubscribe = subscribePowerRuntimeActivity(listener);

		setPowerActiveAgentCount(3);
		setPowerActiveTerminalCount(2);
		reportPowerBrowserSession("one", true);
		reportPowerBrowserSession("two", false);
		reportPowerBrowserRecordingStarted();
		setPowerIndexing(true);

		expect(getPowerRuntimeActivity()).toEqual({
			activeAgents: 3,
			activeTerminals: 2,
			browserSessions: 2,
			activeBrowserSessions: 1,
			browserRecordings: 1,
			indexing: true,
		});
		expect(listener).toHaveBeenCalledTimes(6);

		unsubscribe();
		reportPowerBrowserSession("one", null);
		reportPowerBrowserSession("two", null);
		reportPowerBrowserRecordingStopped();
		setPowerIndexing(false);
		setPowerActiveTerminalCount(0);
		setPowerActiveAgentCount(0);

		expect(listener).toHaveBeenCalledTimes(6);
	});

	it("never reports negative counts", () => {
		reportPowerBrowserRecordingStopped();
		setPowerActiveTerminalCount(-1);

		expect(getPowerRuntimeActivity()).toEqual({
			activeAgents: 0,
			activeTerminals: 0,
			browserSessions: 0,
			activeBrowserSessions: 0,
			browserRecordings: 0,
			indexing: false,
		});
	});
});
