import { describe, expect, test } from "vitest";

import { parseDeepEnergyOutput } from "../../src/deep-energy-profiler.ts";

describe("deep energy profiler", () => {
	test("parses supported package power and thermal readings", () => {
		const summary = parseDeepEnergyOutput(`
CPU Power: 1240 mW
GPU Power: 380 mW
ANE Power: 42 mW
Combined Power (CPU + GPU + ANE): 1662 mW
Current pressure level: Nominal
CPU Power: 1760 mW
GPU Power: 420 mW
`);
		expect(summary).toEqual({
			status: "complete",
			cpuPowerMw: 1500,
			gpuPowerMw: 400,
			anePowerMw: 42,
			combinedPowerMw: 1662,
			thermalPressure: "nominal",
		});
	});

	test("returns an explicit unavailable result for empty output", () => {
		expect(parseDeepEnergyOutput("permission denied")).toEqual({
			status: "unavailable",
			cpuPowerMw: null,
			gpuPowerMw: null,
			anePowerMw: null,
			combinedPowerMw: null,
			reason: "The system profiler did not return energy readings.",
		});
	});
});
