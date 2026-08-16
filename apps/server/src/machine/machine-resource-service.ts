import { readFile, statfs } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";

import { MachineResourceSample } from "@zuse/contracts";
import { Context, Duration, Effect, Layer, Schedule, Stream } from "effect";

const MIN_INTERVAL_MS = 2_000;
const MAX_INTERVAL_MS = 30_000;
const DEFAULT_INTERVAL_MS = 5_000;

export interface CpuCounters {
	readonly idle: number;
	readonly total: number;
	readonly cores: number;
}

export interface ResourceSnapshot {
	readonly sampledAt: number;
	readonly counters: CpuCounters;
	readonly memTotalBytes: number;
	readonly memUsedBytes: number;
	readonly diskTotalBytes: number;
	readonly diskUsedBytes: number;
	readonly diskPath: string;
}

const cpuCountersFromOs = (): CpuCounters => {
	const all = cpus();
	let idle = 0;
	let total = 0;
	for (const cpu of all) {
		idle += cpu.times.idle;
		total +=
			cpu.times.user +
			cpu.times.nice +
			cpu.times.sys +
			cpu.times.idle +
			cpu.times.irq;
	}
	return { idle, total, cores: Math.max(all.length, 1) };
};

/** Aggregate jiffy counters from the first `cpu ` line of /proc/stat. */
export const parseProcStatCounters = (
	text: string,
	cores: number,
): CpuCounters | null => {
	const line = text.split("\n", 1)[0];
	if (line === undefined || !line.startsWith("cpu ")) return null;
	const fields = line.trim().split(/\s+/u).slice(1).map(Number);
	if (fields.length < 5 || fields.some(Number.isNaN)) return null;
	// idle + iowait both count as not-busy time.
	const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
	const total = fields.reduce((sum, value) => sum + value, 0);
	return { idle, total, cores };
};

export const parseMeminfo = (
	text: string,
): { readonly totalBytes: number; readonly usedBytes: number } | null => {
	const kibibytes = (name: string): number | null => {
		const match = new RegExp(`^${name}:\\s+(\\d+) kB`, "mu").exec(text);
		return match?.[1] === undefined ? null : Number(match[1]);
	};
	const total = kibibytes("MemTotal");
	const available = kibibytes("MemAvailable");
	if (total === null || available === null) return null;
	return {
		totalBytes: total * 1024,
		usedBytes: Math.max(total - available, 0) * 1024,
	};
};

/**
 * One point-in-time reading. CPU values are cumulative counters; the watch
 * stream turns consecutive counters into a busy percentage. Every source has
 * an in-process fallback so sampling never fails the stream.
 */
const readSnapshot = Effect.promise(async (): Promise<ResourceSnapshot> => {
	const cores = Math.max(cpus().length, 1);
	let counters = cpuCountersFromOs();
	let memTotalBytes = totalmem();
	let memUsedBytes = Math.max(memTotalBytes - freemem(), 0);
	if (process.platform === "linux") {
		const [stat, meminfo] = await Promise.all([
			readFile("/proc/stat", "utf8").catch(() => null),
			readFile("/proc/meminfo", "utf8").catch(() => null),
		]);
		const procCounters =
			stat === null ? null : parseProcStatCounters(stat, cores);
		if (procCounters !== null) counters = procCounters;
		const procMemory = meminfo === null ? null : parseMeminfo(meminfo);
		if (procMemory !== null) {
			memTotalBytes = procMemory.totalBytes;
			memUsedBytes = procMemory.usedBytes;
		}
	}
	const diskPath = process.cwd();
	const disk = await statfs(diskPath).catch(() => null);
	const diskTotalBytes = disk === null ? 0 : disk.bsize * disk.blocks;
	const diskUsedBytes =
		disk === null ? 0 : disk.bsize * Math.max(disk.blocks - disk.bfree, 0);
	return {
		sampledAt: Date.now(),
		counters,
		memTotalBytes,
		memUsedBytes,
		diskTotalBytes,
		diskUsedBytes,
		diskPath,
	};
});

export const toSample = (
	previous: CpuCounters | undefined,
	snapshot: ResourceSnapshot,
): MachineResourceSample => {
	// Without a prior reading the counters span the whole uptime, so the first
	// emission reports the average load since boot.
	const idleDelta = snapshot.counters.idle - (previous?.idle ?? 0);
	const totalDelta = snapshot.counters.total - (previous?.total ?? 0);
	const busyRatio = totalDelta > 0 ? (totalDelta - idleDelta) / totalDelta : 0;
	return MachineResourceSample.make({
		sampledAt: snapshot.sampledAt,
		cpuCores: snapshot.counters.cores,
		cpuPercent: Math.min(Math.max(busyRatio * 100, 0), 100),
		memTotalBytes: snapshot.memTotalBytes,
		memUsedBytes: snapshot.memUsedBytes,
		diskTotalBytes: snapshot.diskTotalBytes,
		diskUsedBytes: snapshot.diskUsedBytes,
		diskPath: snapshot.diskPath,
	});
};

export interface MachineResourceServiceShape {
	readonly watch: (intervalMs?: number) => Stream.Stream<MachineResourceSample>;
}

export class MachineResourceService extends Context.Service<
	MachineResourceService,
	MachineResourceServiceShape
>()("zuse/MachineResourceService") {}

export const MachineResourceServiceLive = Layer.succeed(
	MachineResourceService,
	MachineResourceService.of({
		watch: (intervalMs) => {
			const interval = Math.min(
				Math.max(intervalMs ?? DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS),
				MAX_INTERVAL_MS,
			);
			return Stream.fromEffect(readSnapshot).pipe(
				Stream.repeat(Schedule.spaced(Duration.millis(interval))),
				Stream.mapAccum(
					(): CpuCounters | undefined => undefined,
					(previous, snapshot) => [
						snapshot.counters,
						[toSample(previous, snapshot)],
					],
				),
			);
		},
	}),
);
