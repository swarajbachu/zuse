import type {
	PowerProcessMetric,
	PowerSnapshot,
	PowerWorkloadState,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	buildPowerRecordingReport,
	PowerMeasurementMonitor,
	summarizePowerSnapshots,
} from "../../src/power-monitor.ts";

const workload: PowerWorkloadState = {
	activeAgents: 0,
	activeTerminals: 0,
	browserSessions: 0,
	activeBrowserSessions: 0,
	browserRecordings: 0,
	indexing: false,
};

const processMetric = (
	overrides: Partial<PowerProcessMetric> = {},
): PowerProcessMetric => ({
	processType: "renderer",
	pid: 42,
	creationTimeMs: 100,
	cpuPercent: 2,
	cumulativeCpuSeconds: 5,
	idleWakeupsPerSecond: 3,
	memoryBytes: 100,
	memoryKind: "working-set",
	...overrides,
});

const snapshot = (
	capturedAt: string,
	overrides: Partial<PowerSnapshot> = {},
): PowerSnapshot => ({
	capturedAt,
	powerSource: "battery",
	thermalState: "nominal",
	windowVisible: true,
	processes: [processMetric()],
	workload,
	totalCpuPercent: 2,
	totalIdleWakeupsPerSecond: 3,
	totalMemoryBytes: 100,
	memoryKind: "working-set",
	...overrides,
});

describe("power measurement summaries", () => {
	it("aggregates CPU, wakeups, memory, and process counts", () => {
		const summary = summarizePowerSnapshots([
			snapshot("2026-07-29T00:00:00.000Z"),
			snapshot("2026-07-29T00:00:05.000Z", {
				totalCpuPercent: 6,
				totalIdleWakeupsPerSecond: 7,
				totalMemoryBytes: 130,
				processes: [processMetric(), processMetric({ pid: 43 })],
			}),
		]);

		expect(summary).toMatchObject({
			durationMs: 5_000,
			sampleCount: 2,
			averageCpuPercent: 6,
			peakCpuPercent: 6,
			averageIdleWakeupsPerSecond: 7,
			memoryChangeBytes: 30,
			peakProcessCount: 2,
		});
	});

	it("builds privacy-safe transition and per-process reports", () => {
		const report = buildPowerRecordingReport({
			id: "power_test",
			durationMinutes: 5,
			snapshots: [
				snapshot("2026-07-29T00:00:00.000Z"),
				snapshot("2026-07-29T00:00:05.000Z", {
					powerSource: "ac",
					thermalState: "fair",
					processes: [
						processMetric({
							cpuPercent: 4,
							cumulativeCpuSeconds: 7,
						}),
					],
					workload: { ...workload, activeAgents: 1 },
				}),
			],
			interactions: [
				{
					recordedAt: "2026-07-29T00:00:03.000Z",
					name: "chat.provider-ready",
					durationMs: 240,
				},
			],
			environment: {
				appVersion: "0.1.0",
				platform: "darwin",
				arch: "arm64",
				osRelease: "25.0.0",
				logicalCpuCount: 10,
				totalMemoryGb: 16,
				processorModel: "Apple",
			},
		});

		expect(report.processes[0]).toMatchObject({
			processType: "renderer",
			cpuSeconds: 2,
			averageCpuPercent: 4,
			peakCpuPercent: 4,
		});
		expect(report.powerTransitions).toHaveLength(2);
		expect(report.thermalTransitions).toHaveLength(2);
		expect(report.workloadTimeline.at(-1)?.workload.activeAgents).toBe(1);
		expect(JSON.stringify(report)).not.toContain("session=");
	});

	it("keeps a process that disappears without attributing later samples to it", () => {
		const report = buildPowerRecordingReport({
			id: "power_process_exit",
			durationMinutes: 5,
			snapshots: [
				snapshot("2026-07-29T00:00:00.000Z", {
					processes: [
						processMetric({ pid: 42 }),
						processMetric({ pid: 43, processType: "utility" }),
					],
				}),
				snapshot("2026-07-29T00:00:05.000Z", {
					processes: [processMetric({ pid: 42 })],
				}),
			],
			interactions: [],
			environment: {
				appVersion: "0.1.0",
				platform: "darwin",
				arch: "arm64",
				osRelease: "25.0.0",
				logicalCpuCount: 10,
				totalMemoryGb: 16,
				processorModel: "Apple",
			},
		});

		expect(report.processes.find((item) => item.pid === 43)).toMatchObject({
			processType: "utility",
			sampleCount: 1,
		});
	});
});

describe("PowerMeasurementMonitor", () => {
	it("uses foreground, recording, and idle sampling intervals", () => {
		let now = Date.parse("2026-07-29T00:00:00.000Z");
		const intervals: number[] = [];
		let nextTimer = 0;
		const cleared: number[] = [];
		const monitor = new PowerMeasurementMonitor({
			now: () => now,
			sample: () => snapshot(new Date(now).toISOString()),
			setInterval: (_callback, intervalMs) => {
				intervals.push(intervalMs);
				nextTimer += 1;
				return nextTimer;
			},
			clearInterval: (timer) => {
				cleared.push(timer as number);
			},
			setTimeout: () => 99,
			clearTimeout: () => undefined,
			id: () => "power_test",
		});

		monitor.start();
		expect(intervals.at(-1)).toBe(15_000);

		monitor.startRecording(5);
		expect(intervals.at(-1)).toBe(5_000);
		expect(cleared).toContain(1);

		now += 61 * 60 * 1_000;
		monitor.sampleNow();
		expect(
			monitor
				.getRecentSnapshots()
				.every((item) => Date.parse(item.capturedAt) >= now - 60 * 60 * 1_000),
		).toBe(true);

		expect(intervals.at(-1)).toBe(15_000);
		expect(monitor.getState().latestRecording?.summary.sampleCount).toBe(2);
	});

	it("drops to one sample per minute while hidden and idle", () => {
		const intervals: number[] = [];
		const monitor = new PowerMeasurementMonitor({
			now: () => Date.parse("2026-07-29T00:00:00.000Z"),
			sample: () =>
				snapshot("2026-07-29T00:00:00.000Z", { windowVisible: false }),
			setInterval: (_callback, intervalMs) => {
				intervals.push(intervalMs);
				return intervals.length;
			},
			clearInterval: () => undefined,
			setTimeout: () => 1,
			clearTimeout: () => undefined,
			id: () => "power_idle",
		});

		monitor.start();
		expect(intervals.at(-1)).toBe(60_000);
	});

	it("completes a recording when stopped manually", () => {
		let now = Date.parse("2026-07-29T00:00:00.000Z");
		const monitor = new PowerMeasurementMonitor({
			now: () => now,
			sample: () => snapshot(new Date(now).toISOString()),
			setInterval: () => 1,
			clearInterval: () => undefined,
			setTimeout: () => 2,
			clearTimeout: () => undefined,
			id: () => "power_manual",
		});

		monitor.start();
		monitor.startRecording(5);
		now += 5_000;
		monitor.sampleNow();
		monitor.stopRecording();

		expect(monitor.getState().activeRecording).toBeNull();
		expect(monitor.getState().latestRecording).toMatchObject({
			id: "power_manual",
			summary: { sampleCount: 2, durationMs: 5_000 },
		});
	});
});
