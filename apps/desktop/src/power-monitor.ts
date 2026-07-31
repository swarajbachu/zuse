import type {
	DeepEnergySummary,
	PowerCompletedRecording,
	PowerInteractionMeasurement,
	PowerMemoryKind,
	PowerMonitorState,
	PowerProcessMetric,
	PowerProcessType,
	PowerRecordingDurationMinutes,
	PowerSnapshot,
	PowerSummary,
	PowerWorkloadState,
} from "@zuse/contracts";
import { POWER_RECORDING_DURATION_MINUTES } from "@zuse/contracts";

const FOREGROUND_SAMPLE_INTERVAL_MS = 15_000;
const IDLE_SAMPLE_INTERVAL_MS = 60_000;
const RECORDING_SAMPLE_INTERVAL_MS = 5_000;
const RETENTION_MS = 60 * 60 * 1_000;
const FIVE_MINUTES_MS = 5 * 60 * 1_000;

type TimerHandle = unknown;

export interface PowerMonitorDependencies {
	readonly now: () => number;
	readonly sample: () => PowerSnapshot;
	readonly setInterval: (
		callback: () => void,
		intervalMs: number,
	) => TimerHandle;
	readonly clearInterval: (timer: TimerHandle) => void;
	readonly setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
	readonly clearTimeout: (timer: TimerHandle) => void;
	readonly id: () => string;
}

interface StoredRecording {
	readonly id: string;
	readonly durationMinutes: PowerRecordingDurationMinutes;
	readonly snapshots: ReadonlyArray<PowerSnapshot>;
}

interface ActiveRecording {
	readonly id: string;
	readonly startedAtMs: number;
	readonly endsAtMs: number;
	readonly durationMinutes: PowerRecordingDurationMinutes;
	readonly snapshots: PowerSnapshot[];
}

const average = (values: ReadonlyArray<number>): number =>
	values.length === 0
		? 0
		: values.reduce((total, value) => total + value, 0) / values.length;

const timeWeightedAverage = (
	snapshots: ReadonlyArray<PowerSnapshot>,
	read: (snapshot: PowerSnapshot) => number,
): number => {
	if (snapshots.length < 2) return read(snapshots[0] as PowerSnapshot);
	let weightedTotal = 0;
	let totalDurationMs = 0;
	for (let index = 1; index < snapshots.length; index += 1) {
		const previous = snapshots[index - 1] as PowerSnapshot;
		const current = snapshots[index] as PowerSnapshot;
		const durationMs = Math.max(
			0,
			Date.parse(current.capturedAt) - Date.parse(previous.capturedAt),
		);
		weightedTotal += read(current) * durationMs;
		totalDurationMs += durationMs;
	}
	return totalDurationMs === 0
		? average(snapshots.map(read))
		: weightedTotal / totalDurationMs;
};

const round = (value: number, digits = 3): number => {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
};

const highestPowerSamples = (
	snapshots: ReadonlyArray<PowerSnapshot>,
): PowerCompletedRecording["highestSamples"] =>
	[...snapshots]
		.sort(
			(left, right) =>
				right.totalCpuPercent - left.totalCpuPercent ||
				right.totalIdleWakeupsPerSecond - left.totalIdleWakeupsPerSecond,
		)
		.slice(0, 5)
		.sort(
			(left, right) =>
				Date.parse(left.capturedAt) - Date.parse(right.capturedAt),
		)
		.map((snapshot) => ({
			capturedAt: snapshot.capturedAt,
			totalCpuPercent: snapshot.totalCpuPercent,
			totalIdleWakeupsPerSecond: snapshot.totalIdleWakeupsPerSecond,
			totalMemoryBytes: snapshot.totalMemoryBytes,
			workload: snapshot.workload,
		}));

export function summarizePowerSnapshots(
	snapshots: ReadonlyArray<PowerSnapshot>,
): PowerSummary | null {
	const first = snapshots[0];
	const last = snapshots.at(-1);
	if (first === undefined || last === undefined) return null;

	const cpu = snapshots.map((item) => item.totalCpuPercent);
	const wakeups = snapshots.map((item) => item.totalIdleWakeupsPerSecond);
	const memory = snapshots.map((item) => item.totalMemoryBytes);

	return {
		startedAt: first.capturedAt,
		endedAt: last.capturedAt,
		durationMs: Math.max(
			0,
			Date.parse(last.capturedAt) - Date.parse(first.capturedAt),
		),
		sampleCount: snapshots.length,
		averageCpuPercent: round(
			timeWeightedAverage(snapshots, (item) => item.totalCpuPercent),
		),
		peakCpuPercent: round(Math.max(...cpu)),
		averageIdleWakeupsPerSecond: round(
			timeWeightedAverage(snapshots, (item) => item.totalIdleWakeupsPerSecond),
		),
		peakIdleWakeupsPerSecond: round(Math.max(...wakeups)),
		startMemoryBytes: first.totalMemoryBytes,
		endMemoryBytes: last.totalMemoryBytes,
		memoryChangeBytes: last.totalMemoryBytes - first.totalMemoryBytes,
		peakMemoryBytes: Math.max(...memory),
		memoryKind: last.memoryKind,
		peakProcessCount: Math.max(
			...snapshots.map((item) => item.processes.length),
		),
	};
}

export class PowerMeasurementMonitor {
	private readonly listeners = new Set<(state: PowerMonitorState) => void>();
	private readonly recentSnapshots: PowerSnapshot[] = [];
	private sampleTimer: TimerHandle | null = null;
	private recordingTimer: TimerHandle | null = null;
	private scheduledIntervalMs: number | null = null;
	private activeRecording: ActiveRecording | null = null;
	private latestRecording: StoredRecording | null = null;
	private started = false;

	constructor(private readonly dependencies: PowerMonitorDependencies) {}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.sampleNow();
	}

	stop(): void {
		this.started = false;
		if (this.sampleTimer !== null) {
			this.dependencies.clearInterval(this.sampleTimer);
			this.sampleTimer = null;
			this.scheduledIntervalMs = null;
		}
		if (this.recordingTimer !== null) {
			this.dependencies.clearTimeout(this.recordingTimer);
			this.recordingTimer = null;
		}
		this.listeners.clear();
	}

	subscribe(listener: (state: PowerMonitorState) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	sampleNow(): PowerSnapshot {
		const snapshot = this.dependencies.sample();
		const now = this.dependencies.now();
		this.recentSnapshots.push(snapshot);
		const cutoff = now - RETENTION_MS;
		while (
			this.recentSnapshots[0] !== undefined &&
			Date.parse(this.recentSnapshots[0].capturedAt) < cutoff
		) {
			this.recentSnapshots.shift();
		}

		if (this.activeRecording !== null) {
			this.activeRecording.snapshots.push(snapshot);
			if (now >= this.activeRecording.endsAtMs) {
				this.completeRecording();
				return snapshot;
			}
		}

		if (
			this.started &&
			this.activeRecording === null &&
			this.scheduledIntervalMs !== this.normalSampleInterval(snapshot)
		) {
			this.scheduleSamples();
		}
		this.emit();
		return snapshot;
	}

	startRecording(durationMinutes: PowerRecordingDurationMinutes): void {
		if (this.activeRecording !== null) {
			throw new Error("A performance recording is already active.");
		}
		if (!POWER_RECORDING_DURATION_MINUTES.includes(durationMinutes)) {
			throw new Error("Performance recordings must be 5, 15, or 30 minutes.");
		}

		const startedAtMs = this.dependencies.now();
		this.activeRecording = {
			id: this.dependencies.id(),
			startedAtMs,
			endsAtMs: startedAtMs + durationMinutes * 60 * 1_000,
			durationMinutes,
			snapshots: [],
		};
		this.scheduleSamples();
		this.sampleNow();
		this.recordingTimer = this.dependencies.setTimeout(
			() => this.stopRecording(),
			durationMinutes * 60 * 1_000,
		);
	}

	stopRecording(): StoredRecording {
		if (this.activeRecording === null) {
			throw new Error("No performance recording is active.");
		}
		if (this.activeRecording.snapshots.length === 0) {
			this.activeRecording.snapshots.push(this.dependencies.sample());
		}
		return this.completeRecording();
	}

	getState(): PowerMonitorState {
		const latestSnapshot = this.recentSnapshots.at(-1) ?? null;
		const fiveMinuteCutoff = this.dependencies.now() - FIVE_MINUTES_MS;
		const fiveMinuteSummary = summarizePowerSnapshots(
			this.recentSnapshots.filter(
				(item) => Date.parse(item.capturedAt) >= fiveMinuteCutoff,
			),
		);
		const active = this.activeRecording;
		const completed = this.latestRecording;
		const completedSummary =
			completed === null ? null : summarizePowerSnapshots(completed.snapshots);

		return {
			latestSnapshot,
			fiveMinuteSummary,
			activeRecording:
				active === null
					? null
					: {
							id: active.id,
							startedAt: new Date(active.startedAtMs).toISOString(),
							endsAt: new Date(active.endsAtMs).toISOString(),
							durationMinutes: active.durationMinutes,
							sampleCount: active.snapshots.length,
						},
			latestRecording:
				completed === null || completedSummary === null
					? null
					: ({
							id: completed.id,
							startedAt: completedSummary.startedAt,
							endedAt: completedSummary.endedAt,
							durationMinutes: completed.durationMinutes,
							summary: completedSummary,
							highestSamples: highestPowerSamples(completed.snapshots),
						} satisfies PowerCompletedRecording),
		};
	}

	getRecentSnapshots(): ReadonlyArray<PowerSnapshot> {
		return this.recentSnapshots.slice();
	}

	getLatestRecording(): StoredRecording | null {
		return this.latestRecording;
	}

	private completeRecording(): StoredRecording {
		const active = this.activeRecording;
		if (active === null) {
			throw new Error("No performance recording is active.");
		}
		if (this.recordingTimer !== null) {
			this.dependencies.clearTimeout(this.recordingTimer);
			this.recordingTimer = null;
		}
		const completed: StoredRecording = {
			id: active.id,
			durationMinutes: active.durationMinutes,
			snapshots: active.snapshots.slice(),
		};
		this.latestRecording = completed;
		this.activeRecording = null;
		this.scheduleSamples();
		this.emit();
		return completed;
	}

	private scheduleSamples(): void {
		if (this.sampleTimer !== null) {
			this.dependencies.clearInterval(this.sampleTimer);
			this.sampleTimer = null;
		}
		this.scheduledIntervalMs = null;
		if (!this.started) return;
		const intervalMs =
			this.activeRecording === null
				? this.normalSampleInterval(this.recentSnapshots.at(-1) ?? null)
				: RECORDING_SAMPLE_INTERVAL_MS;
		this.scheduledIntervalMs = intervalMs;
		this.sampleTimer = this.dependencies.setInterval(
			() => this.sampleNow(),
			intervalMs,
		);
	}

	private normalSampleInterval(snapshot: PowerSnapshot | null): number {
		if (snapshot === null) return FOREGROUND_SAMPLE_INTERVAL_MS;
		const busy =
			snapshot.workload.activeAgents > 0 ||
			snapshot.workload.activeTerminals > 0 ||
			snapshot.workload.activeBrowserSessions > 0 ||
			snapshot.workload.browserRecordings > 0 ||
			snapshot.workload.indexing;
		return snapshot.windowVisible || busy
			? FOREGROUND_SAMPLE_INTERVAL_MS
			: IDLE_SAMPLE_INTERVAL_MS;
	}

	private emit(): void {
		const state = this.getState();
		for (const listener of this.listeners) listener(state);
	}
}

interface PowerEnvironment {
	readonly appVersion: string;
	readonly platform: string;
	readonly arch: string;
	readonly osRelease: string;
	readonly logicalCpuCount: number;
	readonly totalMemoryGb: number;
	readonly processorModel: string;
}

interface PowerProcessReport {
	readonly processType: PowerProcessType;
	readonly pid: number;
	readonly creationTimeMs: number;
	readonly name?: string;
	readonly sampleCount: number;
	readonly averageCpuPercent: number;
	readonly peakCpuPercent: number;
	readonly averageIdleWakeupsPerSecond: number;
	readonly peakIdleWakeupsPerSecond: number;
	readonly averageMemoryBytes: number;
	readonly peakMemoryBytes: number;
	readonly memoryKind: PowerMemoryKind;
	readonly cpuSeconds: number | null;
}

interface PowerTransition {
	readonly capturedAt: string;
	readonly value: string;
}

interface PowerWorkloadPoint {
	readonly capturedAt: string;
	readonly workload: PowerWorkloadState;
	readonly totalCpuPercent: number;
	readonly totalIdleWakeupsPerSecond: number;
	readonly totalMemoryBytes: number;
}

export interface PowerRecordingReport {
	readonly schemaVersion: 1;
	readonly recordingId: string;
	readonly requestedDurationMinutes: PowerRecordingDurationMinutes;
	readonly environment: PowerEnvironment;
	readonly summary: PowerSummary;
	readonly processes: ReadonlyArray<PowerProcessReport>;
	readonly powerTransitions: ReadonlyArray<PowerTransition>;
	readonly thermalTransitions: ReadonlyArray<PowerTransition>;
	readonly workloadTimeline: ReadonlyArray<PowerWorkloadPoint>;
	readonly interactions: ReadonlyArray<PowerInteractionMeasurement>;
	readonly samples: ReadonlyArray<PowerSnapshot>;
	readonly deepEnergy?: DeepEnergySummary;
	readonly attributionNote: string;
}

const processKey = (metric: PowerProcessMetric): string =>
	`${metric.processType}:${metric.pid}:${metric.creationTimeMs}`;

const sameWorkload = (
	left: PowerWorkloadState,
	right: PowerWorkloadState,
): boolean =>
	left.activeAgents === right.activeAgents &&
	left.activeTerminals === right.activeTerminals &&
	left.browserSessions === right.browserSessions &&
	left.activeBrowserSessions === right.activeBrowserSessions &&
	left.browserRecordings === right.browserRecordings &&
	left.indexing === right.indexing;

const transitions = (
	snapshots: ReadonlyArray<PowerSnapshot>,
	read: (snapshot: PowerSnapshot) => string,
): ReadonlyArray<PowerTransition> => {
	const result: PowerTransition[] = [];
	let previous: string | null = null;
	for (const item of snapshots) {
		const value = read(item);
		if (value === previous) continue;
		result.push({ capturedAt: item.capturedAt, value });
		previous = value;
	}
	return result;
};

const processReports = (
	snapshots: ReadonlyArray<PowerSnapshot>,
): ReadonlyArray<PowerProcessReport> => {
	type SampledProcess = {
		readonly capturedAt: string;
		readonly metric: PowerProcessMetric;
	};
	const grouped = new Map<string, SampledProcess[]>();
	for (const snapshot of snapshots) {
		for (const process of snapshot.processes) {
			const key = processKey(process);
			const items = grouped.get(key) ?? [];
			items.push({ capturedAt: snapshot.capturedAt, metric: process });
			grouped.set(key, items);
		}
	}

	return [...grouped.values()]
		.map((items) => {
			const first = (items[0] as SampledProcess).metric;
			const last = (items.at(-1) as SampledProcess).metric;
			const cpuValues = items.map((item) => item.metric.cpuPercent);
			const wakeupValues = items.map(
				(item) => item.metric.idleWakeupsPerSecond,
			);
			const memoryValues = items.map((item) => item.metric.memoryBytes);
			const firstCumulative = first.cumulativeCpuSeconds;
			const lastCumulative = last.cumulativeCpuSeconds;
			const weightedAverage = (
				read: (metric: PowerProcessMetric) => number,
			): number => {
				if (items.length < 2) return read(first);
				let total = 0;
				let durationMs = 0;
				for (let index = 1; index < items.length; index += 1) {
					const previous = items[index - 1] as SampledProcess;
					const current = items[index] as SampledProcess;
					const intervalMs = Math.max(
						0,
						Date.parse(current.capturedAt) - Date.parse(previous.capturedAt),
					);
					total += read(current.metric) * intervalMs;
					durationMs += intervalMs;
				}
				return durationMs === 0
					? average(items.map((item) => read(item.metric)))
					: total / durationMs;
			};
			return {
				processType: first.processType,
				pid: first.pid,
				creationTimeMs: first.creationTimeMs,
				...(first.name === undefined ? {} : { name: first.name }),
				sampleCount: items.length,
				averageCpuPercent: round(
					weightedAverage((metric) => metric.cpuPercent),
				),
				peakCpuPercent: round(Math.max(...cpuValues)),
				averageIdleWakeupsPerSecond: round(
					weightedAverage((metric) => metric.idleWakeupsPerSecond),
				),
				peakIdleWakeupsPerSecond: round(Math.max(...wakeupValues)),
				averageMemoryBytes: Math.round(
					weightedAverage((metric) => metric.memoryBytes),
				),
				peakMemoryBytes: Math.max(...memoryValues),
				memoryKind: last.memoryKind,
				cpuSeconds:
					firstCumulative === null || lastCumulative === null
						? null
						: round(Math.max(0, lastCumulative - firstCumulative)),
			};
		})
		.sort((left, right) => right.peakCpuPercent - left.peakCpuPercent);
};

const workloadTimeline = (
	snapshots: ReadonlyArray<PowerSnapshot>,
): ReadonlyArray<PowerWorkloadPoint> => {
	const points: PowerWorkloadPoint[] = [];
	let previous: PowerWorkloadState | null = null;
	for (const item of snapshots) {
		if (previous !== null && sameWorkload(previous, item.workload)) continue;
		points.push({
			capturedAt: item.capturedAt,
			workload: item.workload,
			totalCpuPercent: item.totalCpuPercent,
			totalIdleWakeupsPerSecond: item.totalIdleWakeupsPerSecond,
			totalMemoryBytes: item.totalMemoryBytes,
		});
		previous = item.workload;
	}
	return points;
};

export function buildPowerRecordingReport(input: {
	readonly id: string;
	readonly durationMinutes: PowerRecordingDurationMinutes;
	readonly snapshots: ReadonlyArray<PowerSnapshot>;
	readonly interactions: ReadonlyArray<PowerInteractionMeasurement>;
	readonly deepEnergy?: DeepEnergySummary;
	readonly environment: PowerEnvironment;
}): PowerRecordingReport {
	const summary = summarizePowerSnapshots(input.snapshots);
	if (summary === null) {
		throw new Error("The performance recording has no samples.");
	}
	return {
		schemaVersion: 1,
		recordingId: input.id,
		requestedDurationMinutes: input.durationMinutes,
		environment: input.environment,
		summary,
		processes: processReports(input.snapshots),
		powerTransitions: transitions(input.snapshots, (item) => item.powerSource),
		thermalTransitions: transitions(
			input.snapshots,
			(item) => item.thermalState,
		),
		workloadTimeline: workloadTimeline(input.snapshots),
		interactions: input.interactions,
		samples: input.snapshots,
		...(input.deepEnergy === undefined ? {} : { deepEnergy: input.deepEnergy }),
		attributionNote:
			"Battery percentage and whole-machine energy use are not attributed exclusively to Zuse. Use a controlled macOS Energy Log or powermetrics run for whole-machine comparisons.",
	};
}

const formatNumber = (value: number, digits = 2): string =>
	value.toFixed(digits);

const formatBytes = (bytes: number): string => {
	const mib = bytes / (1024 * 1024);
	return `${formatNumber(mib, 1)} MiB`;
};

export function powerRecordingReportMarkdown(
	report: PowerRecordingReport,
): string {
	const processRows = report.processes
		.map(
			(item) =>
				`| ${item.processType} | ${item.pid} | ${formatNumber(item.averageCpuPercent)}% | ${formatNumber(item.peakCpuPercent)}% | ${formatNumber(item.averageIdleWakeupsPerSecond)} | ${formatBytes(item.peakMemoryBytes)} | ${item.cpuSeconds === null ? "unavailable" : `${formatNumber(item.cpuSeconds)}s`} |`,
		)
		.join("\n");
	const workloadRows = report.workloadTimeline
		.map(
			(item) =>
				`| ${item.capturedAt} | ${item.workload.activeAgents} | ${item.workload.activeTerminals} | ${item.workload.activeBrowserSessions}/${item.workload.browserSessions} | ${item.workload.browserRecordings} | ${item.workload.indexing ? "yes" : "no"} | ${formatNumber(item.totalCpuPercent)}% |`,
		)
		.join("\n");
	const interactionRows =
		report.interactions.length === 0
			? "| none captured | - | - |"
			: report.interactions
					.map(
						(item) =>
							`| ${item.recordedAt} | ${item.name} | ${formatNumber(item.durationMs, 1)} ms |`,
					)
					.join("\n");

	return `# Zuse performance recording

- Recording: ${report.recordingId}
- App version: ${report.environment.appVersion}
- Platform: ${report.environment.platform}-${report.environment.arch} ${report.environment.osRelease}
- Processor class: ${report.environment.processorModel}
- Logical CPUs: ${report.environment.logicalCpuCount}
- Memory class: ${report.environment.totalMemoryGb} GB
- Started: ${report.summary.startedAt}
- Ended: ${report.summary.endedAt}
- Samples: ${report.summary.sampleCount}

## Summary

| Metric | Value |
| --- | ---: |
| Average CPU | ${formatNumber(report.summary.averageCpuPercent)}% |
| Peak CPU | ${formatNumber(report.summary.peakCpuPercent)}% |
| Average idle wakeups/s | ${formatNumber(report.summary.averageIdleWakeupsPerSecond)} |
| Peak idle wakeups/s | ${formatNumber(report.summary.peakIdleWakeupsPerSecond)} |
| Memory change | ${formatBytes(report.summary.memoryChangeBytes)} |
| Peak memory | ${formatBytes(report.summary.peakMemoryBytes)} |
| Peak Electron process count | ${report.summary.peakProcessCount} |

## Processes

| Type | PID | Avg CPU | Peak CPU | Avg wakeups/s | Peak memory | CPU time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${processRows}

## Workload changes

| Time | Agents | Terminals | Active/total browsers | Recordings | Indexing | CPU |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
${workloadRows}

## Interaction latency

| Time | Measurement | Duration |
| --- | --- | ---: |
${interactionRows}

> ${report.attributionNote}
`;
}

export const powerMonitorInternals = {
	FOREGROUND_SAMPLE_INTERVAL_MS,
	IDLE_SAMPLE_INTERVAL_MS,
	RECORDING_SAMPLE_INTERVAL_MS,
	RETENTION_MS,
	transitions,
	workloadTimeline,
	processReports,
};
