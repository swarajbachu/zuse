import { statfs } from "node:fs/promises";
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

/** One point-in-time reading; the stream derives CPU use from two snapshots. */
const readSnapshot = Effect.promise(async (): Promise<ResourceSnapshot> => {
	const memTotalBytes = totalmem();
	const diskPath = process.cwd();
	const disk = await statfs(diskPath).catch(() => null);
	const diskTotalBytes = disk === null ? 0 : disk.bsize * disk.blocks;
	const diskUsedBytes =
		disk === null ? 0 : disk.bsize * Math.max(disk.blocks - disk.bfree, 0);
	return {
		sampledAt: Date.now(),
		counters: cpuCountersFromOs(),
		memTotalBytes,
		memUsedBytes: Math.max(memTotalBytes - freemem(), 0),
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
