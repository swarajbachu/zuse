import { describe, expect, test } from "vitest";

import {
	parseMacOsBatteryStatus,
	parseWindowsBatteryStatus,
} from "../../src/battery-status.ts";

describe("battery status adapters", () => {
	test("parses macOS battery percentage and charging state", () => {
		expect(
			parseMacOsBatteryStatus(
				"Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t78%; discharging; 3:24 remaining present: true",
			),
		).toEqual({ percent: 78, isCharging: false });
		expect(
			parseMacOsBatteryStatus(
				"Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t43%; charging; 1:12 remaining present: true",
			),
		).toEqual({ percent: 43, isCharging: true });
	});

	test("parses Windows CIM battery output without treating unknown status as zero", () => {
		expect(
			parseWindowsBatteryStatus(
				'{"EstimatedChargeRemaining":67,"BatteryStatus":6}',
			),
		).toEqual({ percent: 67, isCharging: true });
		expect(parseWindowsBatteryStatus("{}")).toEqual({
			percent: null,
			isCharging: null,
		});
	});
});
