import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	descendantProcessTree,
	POWER_BENCHMARK_SCENARIOS,
	type PowerBenchmarkRun,
	type PowerBenchmarkWorkloads,
	parseProcessTree,
	powermetricsReleaseBenchmarkArguments,
	preparePowerBenchmarkScenario,
	readPowerBenchmarkBaseline,
	recordingDurationForBenchmark,
	runPowerBenchmarkScenarioThreeTimes,
	summarizePowerBenchmarkRuns,
	writePowerBenchmarkBaseline,
} from "../../src/power-benchmark.ts";

const run = (
	electronCpu: number,
	treeCpu: number,
	memory: number,
): PowerBenchmarkRun => ({
	scenario: "foreground-idle",
	startedAt: "2026-07-29T00:00:00.000Z",
	endedAt: "2026-07-29T00:01:00.000Z",
	sampleCount: 2,
	averageElectronCpuPercent: electronCpu,
	peakElectronCpuPercent: electronCpu,
	averageProcessTreeCpuPercent: treeCpu,
	peakProcessTreeCpuPercent: treeCpu,
	averageProcessTreeMemoryBytes: memory,
	peakProcessTreeMemoryBytes: memory,
	peakProcessCount: 2,
	samples: [],
});

describe("power benchmark harness", () => {
	it("includes every descendant process without unrelated siblings", () => {
		const parsed = parseProcessTree(`
  10   1  1.5  100 root
  11  10  2.5  200 renderer
  12  11  3.5  300 provider
  20   1  9.0  900 unrelated
`);
		expect(descendantProcessTree(parsed, 10).map((item) => item.pid)).toEqual([
			10, 11, 12,
		]);
	});

	it("reports the median and observed range across three runs", () => {
		const report = summarizePowerBenchmarkRuns({
			runs: [run(1, 2, 100), run(3, 4, 300), run(2, 3, 200)],
		});

		expect(report.median).toMatchObject({
			electronCpuPercent: 2,
			processTreeCpuPercent: 3,
			processTreeMemoryBytes: 200,
		});
		expect(report.range.electronCpuPercent).toEqual([1, 3]);
		expect(report.baselineDelta).toBeNull();

		const compared = summarizePowerBenchmarkRuns({
			runs: [run(2, 3, 300), run(4, 5, 500), run(3, 4, 400)],
			baseline: report,
		});
		expect(compared.baselineDelta).toEqual({
			electronCpuPercent: 1,
			processTreeCpuPercent: 1,
			processTreeMemoryBytes: 200,
		});
	});

	it("selects a recording window that covers the benchmark", () => {
		expect(recordingDurationForBenchmark(30_000)).toBe(5);
		expect(recordingDurationForBenchmark(10 * 60_000)).toBe(15);
		expect(recordingDurationForBenchmark(20 * 60_000)).toBe(30);
		expect(() => recordingDurationForBenchmark(31 * 60_000)).toThrow(
			"cannot exceed 30 minutes",
		);
	});

	it("builds a bounded whole-machine powermetrics capture", () => {
		expect(
			powermetricsReleaseBenchmarkArguments({
				durationMs: 60_000,
				outputPath: "/tmp/power.plist",
			}),
		).toEqual(
			expect.arrayContaining([
				"--sample-rate",
				"5000",
				"--sample-count",
				"12",
				"--show-process-energy",
				"/tmp/power.plist",
			]),
		);
	});

	it("prepares every named deterministic workload", async () => {
		const calls: string[] = [];
		const workloads: PowerBenchmarkWorkloads = {
			stabilizeColdLaunch: async () => {
				calls.push("cold");
			},
			streamAgents: async (count) => {
				calls.push(`agents:${count}`);
			},
			indexRepository: async () => {
				calls.push("index");
			},
			setBrowserPaneActive: async (active) => {
				calls.push(`browser:${active}`);
			},
			cleanup: async () => undefined,
		};
		const evaluate = vi.fn(async (_callback, visible: boolean) => {
			calls.push(`window:${visible}`);
		});
		const electron = {
			app: { evaluate },
		} as unknown as Parameters<
			typeof preparePowerBenchmarkScenario
		>[0]["electron"];

		for (const scenario of POWER_BENCHMARK_SCENARIOS) {
			await preparePowerBenchmarkScenario({ electron, scenario, workloads });
		}

		expect(calls).toEqual([
			"cold",
			"window:true",
			"window:false",
			"window:true",
			"agents:1",
			"window:true",
			"agents:4",
			"window:true",
			"index",
			"window:true",
			"browser:true",
			"window:true",
			"browser:false",
		]);
	});

	it("stores and reloads baselines by machine class and scenario", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-power-baseline-"));
		try {
			const report = summarizePowerBenchmarkRuns({
				runs: [run(1, 2, 100), run(3, 4, 300), run(2, 3, 200)],
			});
			await writePowerBenchmarkBaseline({ directory, report });

			await expect(
				readPowerBenchmarkBaseline({
					directory,
					machineClass: report.machineClass,
					scenario: report.scenario,
				}),
			).resolves.toMatchObject({
				machineClass: report.machineClass,
				scenario: "foreground-idle",
				median: report.median,
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("runs a reference scenario exactly three times before aggregation", async () => {
		const execute = vi.fn(async (runNumber: 1 | 2 | 3) =>
			run(runNumber, runNumber + 1, runNumber * 100),
		);

		const report = await runPowerBenchmarkScenarioThreeTimes({
			scenario: "foreground-idle",
			run: execute,
		});

		expect(execute.mock.calls.map(([runNumber]) => runNumber)).toEqual([
			1, 2, 3,
		]);
		expect(report.runs).toHaveLength(3);
		expect(report.median.electronCpuPercent).toBe(2);
	});
});
