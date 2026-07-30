import type {
	LagSample,
	PerformanceConfidence,
	PerformanceIncident,
	PerformanceOverview,
	PowerProcessMetric,
	PowerSnapshot,
	ProcessResourceSample,
} from "@zuse/contracts";

const MINUTE_MS = 60_000;
const MIB = 1024 * 1024;
const minuteBucket = (createdAt: string): number =>
	Math.floor(Date.parse(createdAt) / MINUTE_MS);

const average = (values: ReadonlyArray<number>): number =>
	values.length === 0
		? 0
		: values.reduce((total, value) => total + value, 0) / values.length;

const round = (value: number, digits = 2): number => {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
};

const durationBetween = (
	first: { readonly capturedAt: string },
	last: { readonly capturedAt: string },
): number =>
	Math.max(0, Date.parse(last.capturedAt) - Date.parse(first.capturedAt));

const contributorFor = (
	pressureSamples: ReadonlyArray<PowerSnapshot>,
): { readonly label?: string; readonly confidence: PerformanceConfidence } => {
	const active = pressureSamples.filter(
		(sample) =>
			sample.workload.activeAgents > 0 ||
			sample.workload.activeTerminals > 0 ||
			sample.workload.activeBrowserSessions > 0 ||
			sample.workload.browserRecordings > 0 ||
			sample.workload.indexing,
	);
	if (active.length === 0) return { confidence: "low" };
	const ratio = active.length / pressureSamples.length;
	const confidence: PerformanceConfidence = ratio >= 0.5 ? "medium" : "low";
	const counts = {
		"Agent activity": active.filter((item) => item.workload.activeAgents > 0)
			.length,
		"Terminal activity": active.filter(
			(item) => item.workload.activeTerminals > 0,
		).length,
		"Browser activity": active.filter(
			(item) =>
				item.workload.activeBrowserSessions > 0 ||
				item.workload.browserRecordings > 0,
		).length,
		"Repository indexing": active.filter((item) => item.workload.indexing)
			.length,
	};
	const label = Object.entries(counts)
		.sort((left, right) => right[1] - left[1])
		.at(0)?.[0];
	return { ...(label === undefined ? {} : { label }), confidence };
};

const incident = (
	input: Omit<PerformanceIncident, "id">,
): PerformanceIncident => ({
	...input,
	id: `performance-${input.kind}-${input.startedAt}`,
});

const processKey = (process: PowerProcessMetric): string =>
	`${process.processType}:${process.pid}:${process.creationTimeMs}`;

const processHotspots = (
	samples: ReadonlyArray<PowerSnapshot>,
): ReadonlyArray<ProcessResourceSample> => {
	const grouped = new Map<string, PowerProcessMetric[]>();
	for (const snapshot of samples) {
		for (const process of snapshot.processes) {
			const key = processKey(process);
			grouped.set(key, [...(grouped.get(key) ?? []), process]);
		}
	}
	return [...grouped.values()]
		.map((metrics) => {
			const first = metrics[0] as PowerProcessMetric;
			const last = metrics.at(-1) as PowerProcessMetric;
			const cpuSeconds =
				first.cumulativeCpuSeconds === null ||
				last.cumulativeCpuSeconds === null
					? null
					: round(
							Math.max(
								0,
								last.cumulativeCpuSeconds - first.cumulativeCpuSeconds,
							),
						);
			return {
				processType: first.processType,
				pid: first.pid,
				...(first.name === undefined ? {} : { name: first.name }),
				averageCpuPercent: round(
					average(metrics.map((item) => item.cpuPercent)),
				),
				peakCpuPercent: round(
					Math.max(...metrics.map((item) => item.cpuPercent)),
				),
				cpuSeconds,
				averageIdleWakeupsPerSecond: round(
					average(metrics.map((item) => item.idleWakeupsPerSecond)),
				),
				peakMemoryBytes: Math.max(...metrics.map((item) => item.memoryBytes)),
				memoryGrowthBytes: last.memoryBytes - first.memoryBytes,
			};
		})
		.sort(
			(left, right) =>
				right.averageCpuPercent - left.averageCpuPercent ||
				right.peakMemoryBytes - left.peakMemoryBytes,
		);
};

const batteryDrain = (
	samples: ReadonlyArray<PowerSnapshot>,
): {
	readonly value: number | null;
	readonly confidence: PerformanceConfidence;
} => {
	const usable = samples.filter(
		(sample) =>
			sample.powerSource === "battery" &&
			sample.isCharging !== true &&
			typeof sample.batteryPercent === "number",
	);
	const first = usable[0];
	const last = usable.at(-1);
	if (first === undefined || last === undefined) {
		return { value: null, confidence: "low" };
	}
	const durationMs = durationBetween(first, last);
	if (durationMs < 10 * MINUTE_MS) {
		return { value: null, confidence: "low" };
	}
	const drop =
		(first.batteryPercent as number) - (last.batteryPercent as number);
	if (drop <= 0) return { value: 0, confidence: "low" };
	return {
		value: round(drop / (durationMs / (60 * MINUTE_MS))),
		confidence:
			durationMs >= 30 * MINUTE_MS
				? "high"
				: durationMs >= 15 * MINUTE_MS
					? "medium"
					: "low",
	};
};

export function analyzePerformanceHistory(
	inputSamples: ReadonlyArray<PowerSnapshot>,
	lagSamples: ReadonlyArray<LagSample>,
): PerformanceOverview {
	const sortedSamples = [...inputSamples].sort((left, right) =>
		left.capturedAt.localeCompare(right.capturedAt),
	);
	const sortedDuration =
		sortedSamples.length < 2
			? 0
			: durationBetween(
					sortedSamples[0] as PowerSnapshot,
					sortedSamples.at(-1) as PowerSnapshot,
				);
	const samples =
		sortedDuration < 5 * MINUTE_MS
			? sortedSamples
			: [
					...new Map(
						sortedSamples.map((sample) => [
							minuteBucket(sample.capturedAt),
							sample,
						]),
					).values(),
				];
	const first = samples[0];
	const last = samples.at(-1);
	const readAt = new Date().toISOString();
	if (first === undefined || last === undefined) {
		return {
			readAt,
			sampleCount: 0,
			averageCpuPercent: 0,
			peakCpuPercent: 0,
			peakMemoryBytes: 0,
			memoryGrowthBytes: 0,
			averageIdleWakeupsPerSecond: 0,
			eventLoopP99Ms: 0,
			batteryDrainPercentPerHour: null,
			batteryDrainConfidence: "low",
			thermalState: "unknown",
			responsiveness: "good",
			incidents: [],
			hotspots: [],
		};
	}

	const incidents: PerformanceIncident[] = [];
	const elapsedMs = durationBetween(first, last);
	const cpuValues = samples.map((item) => item.totalCpuPercent);
	const wakeupValues = samples.map((item) => item.totalIdleWakeupsPerSecond);
	const memoryValues = samples.map((item) => item.totalMemoryBytes);
	const averageCpuPercent = average(cpuValues);
	const averageWakeups = average(wakeupValues);
	const memoryGrowthBytes = last.totalMemoryBytes - first.totalMemoryBytes;

	if (elapsedMs >= MINUTE_MS && averageCpuPercent >= 100) {
		const contributor = contributorFor(
			samples.filter((item) => item.totalCpuPercent >= 100),
		);
		incidents.push(
			incident({
				kind: "cpu",
				severity: averageCpuPercent >= 200 ? "warn" : "info",
				startedAt: first.capturedAt,
				endedAt: last.capturedAt,
				message: "Sustained CPU usage",
				value: round(averageCpuPercent),
				unit: "%",
				occurrences: samples.filter((item) => item.totalCpuPercent >= 100)
					.length,
				confidence: contributor.confidence,
				...(contributor.label === undefined
					? {}
					: { likelyContributor: contributor.label }),
			}),
		);
	}

	if (elapsedMs >= MINUTE_MS && averageWakeups >= 50) {
		const contributor = contributorFor(
			samples.filter((item) => item.totalIdleWakeupsPerSecond >= 50),
		);
		incidents.push(
			incident({
				kind: "wakeups",
				severity: averageWakeups >= 150 ? "warn" : "info",
				startedAt: first.capturedAt,
				endedAt: last.capturedAt,
				message: "Sustained idle wakeups",
				value: round(averageWakeups),
				unit: "wakeups/s",
				occurrences: samples.filter(
					(item) => item.totalIdleWakeupsPerSecond >= 50,
				).length,
				confidence: contributor.confidence,
				...(contributor.label === undefined
					? {}
					: { likelyContributor: contributor.label }),
			}),
		);
	}

	if (
		elapsedMs >= 15 * MINUTE_MS &&
		memoryGrowthBytes >= 128 * MIB &&
		last.totalMemoryBytes >= Math.max(...memoryValues.slice(-3))
	) {
		const contributor = contributorFor(
			samples.filter(
				(item) => item.totalMemoryBytes >= first.totalMemoryBytes + 64 * MIB,
			),
		);
		incidents.push(
			incident({
				kind: "memory-growth",
				severity: memoryGrowthBytes >= 512 * MIB ? "error" : "warn",
				startedAt: first.capturedAt,
				endedAt: last.capturedAt,
				message: "Memory kept growing without recovery",
				value: Math.round(memoryGrowthBytes),
				unit: "bytes",
				occurrences: samples.length,
				confidence: "medium",
				...(contributor.label === undefined
					? {}
					: { likelyContributor: contributor.label }),
			}),
		);
	}

	const drain = batteryDrain(samples);
	if (drain.value !== null && drain.value >= 10) {
		const contributor = contributorFor(
			samples.filter(
				(item) =>
					item.powerSource === "battery" &&
					item.isCharging !== true &&
					typeof item.batteryPercent === "number",
			),
		);
		incidents.push(
			incident({
				kind: "battery-drain",
				severity: drain.value >= 25 ? "warn" : "info",
				startedAt: first.capturedAt,
				endedAt: last.capturedAt,
				message: "High estimated battery drain",
				value: drain.value,
				unit: "%/h",
				occurrences: 1,
				confidence: drain.confidence,
				...(contributor.label === undefined
					? {}
					: { likelyContributor: contributor.label }),
			}),
		);
	}

	if (last.thermalState === "serious" || last.thermalState === "critical") {
		incidents.push(
			incident({
				kind: "thermal",
				severity: "error",
				startedAt: last.capturedAt,
				endedAt: last.capturedAt,
				message: `System thermal pressure is ${last.thermalState}`,
				value: last.thermalState === "critical" ? 2 : 1,
				unit: "state",
				occurrences: 1,
				confidence: "high",
			}),
		);
	}

	const meaningfulLag = lagSamples.filter((item) => item.durationMs >= 100);
	const maxLag = Math.max(0, ...meaningfulLag.map((item) => item.durationMs));
	if (meaningfulLag.length > 0) {
		incidents.push(
			incident({
				kind: "lag",
				severity: maxLag >= 500 ? "error" : "warn",
				startedAt: meaningfulLag[0]?.capturedAt ?? first.capturedAt,
				endedAt: meaningfulLag.at(-1)?.capturedAt ?? last.capturedAt,
				message:
					maxLag >= 500
						? "Repeated severe interface stalls"
						: "Repeated interface stalls",
				value: round(maxLag),
				unit: "ms",
				occurrences: meaningfulLag.length,
				confidence: "high",
			}),
		);
	}

	const eventLoopP99Ms = Math.max(
		0,
		...samples.map((item) => item.eventLoopP99Ms ?? 0),
	);
	const responsiveness =
		maxLag >= 500 || eventLoopP99Ms >= 500
			? "poor"
			: maxLag >= 100 || eventLoopP99Ms >= 100
				? "degraded"
				: "good";

	return {
		readAt,
		sampleCount: samples.length,
		averageCpuPercent: round(averageCpuPercent),
		peakCpuPercent: round(Math.max(...cpuValues)),
		peakMemoryBytes: Math.max(...memoryValues),
		memoryGrowthBytes,
		averageIdleWakeupsPerSecond: round(averageWakeups),
		eventLoopP99Ms: round(eventLoopP99Ms),
		batteryDrainPercentPerHour: drain.value,
		batteryDrainConfidence: drain.confidence,
		thermalState: last.thermalState,
		responsiveness,
		incidents,
		hotspots: processHotspots(samples),
	};
}
