import { describe, expect, test } from "vitest";

import {
	parseMeminfo,
	parseProcStatCounters,
	type ResourceSnapshot,
	toSample,
} from "../../src/machine/machine-resource-service.ts";

const PROC_STAT = [
	"cpu  2000 100 900 6000 1000 0 50 0 0 0",
	"cpu0 1000 50 450 3000 500 0 25 0 0 0",
	"intr 12345",
].join("\n");

const MEMINFO = [
	"MemTotal:       16384000 kB",
	"MemFree:         2048000 kB",
	"MemAvailable:   12288000 kB",
	"Buffers:          512000 kB",
].join("\n");

const snapshot = (
	counters: ResourceSnapshot["counters"],
): ResourceSnapshot => ({
	sampledAt: 1_000,
	counters,
	memTotalBytes: 16_384_000 * 1024,
	memUsedBytes: 4_096_000 * 1024,
	diskTotalBytes: 100_000_000,
	diskUsedBytes: 36_000_000,
	diskPath: "/home/zuse/workspace",
});

describe("machine resource sampling", () => {
	test("parses aggregate cpu counters from /proc/stat", () => {
		const counters = parseProcStatCounters(PROC_STAT, 8);
		// idle (6000) + iowait (1000); total is the sum of all jiffy fields.
		expect(counters).toEqual({ idle: 7000, total: 10_050, cores: 8 });
	});

	test("rejects malformed /proc/stat content", () => {
		expect(parseProcStatCounters("bogus", 4)).toBeNull();
		expect(parseProcStatCounters("cpu  12 abc", 4)).toBeNull();
	});

	test("parses used memory from /proc/meminfo as total minus available", () => {
		expect(parseMeminfo(MEMINFO)).toEqual({
			totalBytes: 16_384_000 * 1024,
			usedBytes: 4_096_000 * 1024,
		});
		expect(parseMeminfo("MemTotal: 1 kB")).toBeNull();
	});

	test("computes busy percentage from consecutive counter deltas", () => {
		const first = toSample(
			undefined,
			snapshot({ idle: 7000, total: 10_000, cores: 8 }),
		);
		expect(first.cpuPercent).toBeCloseTo(30);
		expect(first.cpuCores).toBe(8);

		// 1000 total jiffies elapsed, 900 of them idle -> 10% busy.
		const second = toSample(
			{ idle: 7000, total: 10_000, cores: 8 },
			snapshot({ idle: 7900, total: 11_000, cores: 8 }),
		);
		expect(second.cpuPercent).toBeCloseTo(10);
		expect(second.memUsedBytes).toBe(4_096_000 * 1024);
		expect(second.diskTotalBytes).toBe(100_000_000);
	});

	test("clamps percentage when counters go backwards", () => {
		const sample = toSample(
			{ idle: 8000, total: 12_000, cores: 8 },
			snapshot({ idle: 7000, total: 11_000, cores: 8 }),
		);
		expect(sample.cpuPercent).toBeGreaterThanOrEqual(0);
		expect(sample.cpuPercent).toBeLessThanOrEqual(100);
	});
});
