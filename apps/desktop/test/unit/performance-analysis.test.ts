import type { LagSample, PowerSnapshot } from "@zuse/contracts";
import { describe, expect, test } from "vitest";

import { analyzePerformanceHistory } from "../../src/performance-analysis.ts";

const mib = 1024 * 1024;

const sample = (
	minute: number,
	overrides: Partial<PowerSnapshot> = {},
): PowerSnapshot => ({
	capturedAt: new Date(Date.UTC(2026, 6, 31, 0, minute)).toISOString(),
	powerSource: "battery",
	thermalState: "nominal",
	windowVisible: true,
	processes: [
		{
			processType: "renderer",
			pid: 10,
			creationTimeMs: 1,
			name: "renderer",
			cpuPercent: 120,
			cumulativeCpuSeconds: minute * 72,
			idleWakeupsPerSecond: 20,
			memoryBytes: (500 + minute * 20) * mib,
			memoryKind: "private",
		},
	],
	workload: {
		activeAgents: 1,
		activeTerminals: 0,
		browserSessions: 0,
		activeBrowserSessions: 0,
		browserRecordings: 0,
		indexing: false,
	},
	totalCpuPercent: 120,
	totalIdleWakeupsPerSecond: 20,
	totalMemoryBytes: (500 + minute * 20) * mib,
	memoryKind: "private",
	logicalCpuCount: 8,
	eventLoopP99Ms: 25,
	batteryPercent: 80 - minute,
	isCharging: false,
	...overrides,
});

describe("analyzePerformanceHistory", () => {
	test("attributes sustained CPU and memory growth without claiming certainty", () => {
		const samples = Array.from({ length: 16 }, (_, minute) => sample(minute));
		const result = analyzePerformanceHistory(samples, []);

		expect(result.sampleCount).toBe(16);
		expect(result.incidents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "cpu",
					confidence: "medium",
					likelyContributor: "Agent activity",
				}),
				expect.objectContaining({
					kind: "memory-growth",
					severity: "warn",
				}),
			]),
		);
		expect(result.hotspots[0]).toEqual(
			expect.objectContaining({
				processType: "renderer",
				pid: 10,
				peakCpuPercent: 120,
				memoryGrowthBytes: 300 * mib,
			}),
		);
	});

	test("estimates battery drain only after ten minutes on battery", () => {
		const insufficient = analyzePerformanceHistory(
			Array.from({ length: 10 }, (_, minute) => sample(minute)),
			[],
		);
		expect(insufficient.batteryDrainPercentPerHour).toBeNull();
		expect(insufficient.batteryDrainConfidence).toBe("low");

		const sufficient = analyzePerformanceHistory(
			Array.from({ length: 31 }, (_, minute) => sample(minute)),
			[],
		);
		expect(sufficient.batteryDrainPercentPerHour).toBe(60);
		expect(sufficient.batteryDrainConfidence).toBe("high");
	});

	test("groups repeated renderer stalls into one severe lag incident", () => {
		const lagSamples: LagSample[] = [0, 1, 2].map((minute) => ({
			id: `lag-${minute}`,
			capturedAt: sample(minute).capturedAt,
			kind: "long-task",
			durationMs: 650 + minute,
			source: "renderer",
			name: "renderer.long-task",
		}));
		const result = analyzePerformanceHistory(
			[sample(0), sample(2)],
			lagSamples,
		);

		expect(result.responsiveness).toBe("poor");
		expect(result.incidents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "lag",
					severity: "error",
					occurrences: 3,
					value: 652,
				}),
			]),
		);
	});

	test("reports serious thermal pressure immediately", () => {
		const result = analyzePerformanceHistory(
			[sample(0, { thermalState: "serious" })],
			[],
		);
		expect(result.incidents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "thermal",
					severity: "error",
				}),
			]),
		);
	});
});
