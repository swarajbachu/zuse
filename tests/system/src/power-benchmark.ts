import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { PowerMonitorState } from "@zuse/contracts";
import type { ElectronHarness } from "./electron-app.ts";

const execFileAsync = promisify(execFile);

export const POWER_BENCHMARK_SCENARIOS = [
	"cold-launch",
	"foreground-idle",
	"hidden-idle",
	"one-streaming-agent",
	"four-streaming-agents",
	"repository-indexing",
	"active-browser",
	"inactive-browser",
] as const;

export type PowerBenchmarkScenario = (typeof POWER_BENCHMARK_SCENARIOS)[number];

export interface ProcessTreeMetric {
	readonly pid: number;
	readonly parentPid: number;
	readonly cpuPercent: number;
	readonly residentMemoryBytes: number;
	readonly command: string;
}

export interface PowerBenchmarkSample {
	readonly capturedAt: string;
	readonly monitor: PowerMonitorState;
	readonly processTree: ReadonlyArray<ProcessTreeMetric>;
}

export interface PowerBenchmarkRun {
	readonly scenario: PowerBenchmarkScenario;
	readonly startedAt: string;
	readonly endedAt: string;
	readonly sampleCount: number;
	readonly averageElectronCpuPercent: number;
	readonly peakElectronCpuPercent: number;
	readonly averageProcessTreeCpuPercent: number;
	readonly peakProcessTreeCpuPercent: number;
	readonly averageProcessTreeMemoryBytes: number;
	readonly peakProcessTreeMemoryBytes: number;
	readonly peakProcessCount: number;
	readonly samples: ReadonlyArray<PowerBenchmarkSample>;
}

export interface PowerBenchmarkAggregate {
	readonly schemaVersion: 1;
	readonly machineClass: string;
	readonly scenario: PowerBenchmarkScenario;
	readonly runs: ReadonlyArray<PowerBenchmarkRun>;
	readonly median: {
		readonly electronCpuPercent: number;
		readonly processTreeCpuPercent: number;
		readonly processTreeMemoryBytes: number;
	};
	readonly range: {
		readonly electronCpuPercent: readonly [number, number];
		readonly processTreeCpuPercent: readonly [number, number];
		readonly processTreeMemoryBytes: readonly [number, number];
	};
	readonly baselineDelta: {
		readonly electronCpuPercent: number;
		readonly processTreeCpuPercent: number;
		readonly processTreeMemoryBytes: number;
	} | null;
	readonly energyAttributionNote: string;
}

export interface PowerBenchmarkWorkloads {
	readonly stabilizeColdLaunch: () => Promise<void>;
	readonly streamAgents: (count: 1 | 4) => Promise<void>;
	readonly indexRepository: () => Promise<void>;
	readonly setBrowserPaneActive: (active: boolean) => Promise<void>;
	readonly cleanup: () => Promise<void>;
}

const average = (values: ReadonlyArray<number>): number =>
	values.length === 0
		? 0
		: values.reduce((total, value) => total + value, 0) / values.length;

const round = (value: number): number => Math.round(value * 1_000) / 1_000;

export const parseProcessTree = (output: string): ProcessTreeMetric[] =>
	output
		.split("\n")
		.flatMap((line) => {
			const match = line.match(
				/^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<cpu>[\d.]+)\s+(?<rss>\d+)\s+(?<command>.+?)\s*$/,
			);
			if (match?.groups === undefined) return [];
			return [
				{
					pid: Number(match.groups.pid),
					parentPid: Number(match.groups.ppid),
					cpuPercent: Number(match.groups.cpu),
					residentMemoryBytes: Number(match.groups.rss) * 1024,
					command: basename(match.groups.command ?? "unknown"),
				},
			];
		})
		.filter(
			(metric) =>
				Number.isFinite(metric.pid) &&
				Number.isFinite(metric.parentPid) &&
				Number.isFinite(metric.cpuPercent) &&
				Number.isFinite(metric.residentMemoryBytes),
		);

export const descendantProcessTree = (
	processes: ReadonlyArray<ProcessTreeMetric>,
	rootPid: number,
): ReadonlyArray<ProcessTreeMetric> => {
	const included = new Set([rootPid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const process of processes) {
			if (!included.has(process.parentPid) || included.has(process.pid)) {
				continue;
			}
			included.add(process.pid);
			changed = true;
		}
	}
	return processes.filter((process) => included.has(process.pid));
};

export const readDescendantProcessTree = async (
	rootPid: number,
): Promise<ReadonlyArray<ProcessTreeMetric>> => {
	if (process.platform !== "darwin") return [];
	const { stdout } = await execFileAsync("/bin/ps", [
		"-axo",
		"pid=,ppid=,%cpu=,rss=,comm=",
	]);
	return descendantProcessTree(parseProcessTree(stdout), rootPid);
};

export const powermetricsReleaseBenchmarkArguments = (input: {
	readonly durationMs: number;
	readonly sampleRateMs?: number;
	readonly outputPath: string;
}): ReadonlyArray<string> => {
	const sampleRateMs = Math.max(1_000, input.sampleRateMs ?? 5_000);
	const sampleCount = Math.max(1, Math.ceil(input.durationMs / sampleRateMs));
	return [
		"--sample-rate",
		String(sampleRateMs),
		"--sample-count",
		String(sampleCount),
		"--samplers",
		"tasks,battery,thermal,cpu_power,gpu_power",
		"--show-process-energy",
		"--show-usage-summary",
		"--format",
		"plist",
		"--output-file",
		input.outputPath,
	];
};

export const runPowermetricsReleaseBenchmark = async (input: {
	readonly durationMs: number;
	readonly sampleRateMs?: number;
	readonly outputPath: string;
}): Promise<void> => {
	if (process.platform !== "darwin") {
		throw new Error("powermetrics release benchmarks require macOS.");
	}
	await execFileAsync(
		"/usr/bin/powermetrics",
		powermetricsReleaseBenchmarkArguments(input),
	);
};

const readMonitorState = async (
	electron: ElectronHarness,
): Promise<PowerMonitorState> =>
	electron.page.evaluate(async () => {
		const target = globalThis as typeof globalThis & {
			window?: {
				zuse?: {
					power?: { getState: () => Promise<PowerMonitorState> };
				};
			};
		};
		const bridge = target.window?.zuse?.power;
		if (bridge === undefined) {
			throw new Error("The performance preload bridge is unavailable.");
		}
		return bridge.getState();
	});

export const recordingDurationForBenchmark = (
	durationMs: number,
): 5 | 15 | 30 => {
	const durationMinutes = Math.max(0, durationMs) / (60 * 1_000);
	if (durationMinutes <= 5) return 5;
	if (durationMinutes <= 15) return 15;
	if (durationMinutes <= 30) return 30;
	throw new Error("A single performance benchmark cannot exceed 30 minutes.");
};

const startBenchmarkRecording = async (
	electron: ElectronHarness,
	durationMs: number,
): Promise<void> => {
	await electron.page.evaluate(async (duration) => {
		const target = globalThis as typeof globalThis & {
			window?: {
				zuse?: {
					power?: {
						startRecording: (minutes: 5 | 15 | 30) => Promise<unknown>;
					};
				};
			};
		};
		const bridge = target.window?.zuse?.power;
		if (bridge === undefined) {
			throw new Error("The performance preload bridge is unavailable.");
		}
		await bridge.startRecording(duration);
	}, recordingDurationForBenchmark(durationMs));
};

const stopBenchmarkRecording = async (
	electron: ElectronHarness,
): Promise<void> => {
	await electron.page.evaluate(async () => {
		const target = globalThis as typeof globalThis & {
			window?: {
				zuse?: { power?: { stopRecording: () => Promise<unknown> } };
			};
		};
		await target.window?.zuse?.power?.stopRecording();
	});
};

const setElectronWindowVisible = async (
	electron: ElectronHarness,
	visible: boolean,
): Promise<void> => {
	await electron.app.evaluate(({ BrowserWindow }, show) => {
		const window = BrowserWindow.getAllWindows()[0];
		if (show) {
			window?.show();
			window?.focus();
		} else {
			window?.hide();
		}
	}, visible);
};

export const preparePowerBenchmarkScenario = async (input: {
	readonly electron: ElectronHarness;
	readonly scenario: PowerBenchmarkScenario;
	readonly workloads: PowerBenchmarkWorkloads;
}): Promise<void> => {
	switch (input.scenario) {
		case "cold-launch":
			await input.workloads.stabilizeColdLaunch();
			return;
		case "foreground-idle":
			await setElectronWindowVisible(input.electron, true);
			return;
		case "hidden-idle":
			await setElectronWindowVisible(input.electron, false);
			return;
		case "one-streaming-agent":
			await setElectronWindowVisible(input.electron, true);
			await input.workloads.streamAgents(1);
			return;
		case "four-streaming-agents":
			await setElectronWindowVisible(input.electron, true);
			await input.workloads.streamAgents(4);
			return;
		case "repository-indexing":
			await setElectronWindowVisible(input.electron, true);
			await input.workloads.indexRepository();
			return;
		case "active-browser":
			await setElectronWindowVisible(input.electron, true);
			await input.workloads.setBrowserPaneActive(true);
			return;
		case "inactive-browser":
			await setElectronWindowVisible(input.electron, true);
			await input.workloads.setBrowserPaneActive(false);
			return;
	}
};

export const capturePowerBenchmarkScenario = async (input: {
	readonly electron: ElectronHarness;
	readonly scenario: PowerBenchmarkScenario;
	readonly durationMs: number;
	readonly intervalMs?: number;
	readonly workloads: PowerBenchmarkWorkloads;
}): Promise<PowerBenchmarkRun> => {
	await preparePowerBenchmarkScenario(input);
	try {
		return await capturePowerBenchmarkRun(input);
	} finally {
		await input.workloads.cleanup();
	}
};

export const runPowerBenchmarkScenarioThreeTimes = async (input: {
	readonly scenario: PowerBenchmarkScenario;
	readonly run: (runNumber: 1 | 2 | 3) => Promise<PowerBenchmarkRun>;
	readonly baseline?: PowerBenchmarkAggregate;
}): Promise<PowerBenchmarkAggregate> => {
	const runs: PowerBenchmarkRun[] = [];
	for (const runNumber of [1, 2, 3] as const) {
		const result = await input.run(runNumber);
		if (result.scenario !== input.scenario) {
			throw new Error(
				`Benchmark run ${runNumber} returned ${result.scenario}, expected ${input.scenario}.`,
			);
		}
		runs.push(result);
	}
	return summarizePowerBenchmarkRuns({
		runs,
		...(input.baseline === undefined ? {} : { baseline: input.baseline }),
	});
};

export const capturePowerBenchmarkRun = async (input: {
	readonly electron: ElectronHarness;
	readonly scenario: PowerBenchmarkScenario;
	readonly durationMs: number;
	readonly intervalMs?: number;
}): Promise<PowerBenchmarkRun> => {
	const startedAt = new Date().toISOString();
	const startedAtMs = Date.now();
	const intervalMs = Math.max(250, input.intervalMs ?? 5_000);
	const samples: PowerBenchmarkSample[] = [];
	await startBenchmarkRecording(input.electron, input.durationMs);
	try {
		do {
			const [monitor, processTree] = await Promise.all([
				readMonitorState(input.electron),
				readDescendantProcessTree(input.electron.app.process().pid ?? -1),
			]);
			samples.push({
				capturedAt: new Date().toISOString(),
				monitor,
				processTree,
			});
			const remaining = input.durationMs - (Date.now() - startedAtMs);
			if (remaining <= 0) break;
			await new Promise((resolve) =>
				setTimeout(resolve, Math.min(intervalMs, remaining)),
			);
		} while (Date.now() - startedAtMs <= input.durationMs);
	} finally {
		await stopBenchmarkRecording(input.electron);
	}

	const electronCpu = samples.map(
		(sample) => sample.monitor.latestSnapshot?.totalCpuPercent ?? 0,
	);
	const treeCpu = samples.map((sample) =>
		sample.processTree.reduce(
			(total, process) => total + process.cpuPercent,
			0,
		),
	);
	const treeMemory = samples.map((sample) =>
		sample.processTree.reduce(
			(total, process) => total + process.residentMemoryBytes,
			0,
		),
	);

	return {
		scenario: input.scenario,
		startedAt,
		endedAt: new Date().toISOString(),
		sampleCount: samples.length,
		averageElectronCpuPercent: round(average(electronCpu)),
		peakElectronCpuPercent: round(Math.max(...electronCpu)),
		averageProcessTreeCpuPercent: round(average(treeCpu)),
		peakProcessTreeCpuPercent: round(Math.max(...treeCpu)),
		averageProcessTreeMemoryBytes: Math.round(average(treeMemory)),
		peakProcessTreeMemoryBytes: Math.max(...treeMemory),
		peakProcessCount: Math.max(
			...samples.map((sample) => sample.processTree.length),
		),
		samples,
	};
};

const median = (values: ReadonlyArray<number>): number => {
	const sorted = [...values].sort((left, right) => left - right);
	if (sorted.length === 0) return 0;
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
		: (sorted[middle] ?? 0);
};

const range = (values: ReadonlyArray<number>): readonly [number, number] =>
	values.length === 0 ? [0, 0] : [Math.min(...values), Math.max(...values)];

export const referenceMachineClass = (): string => {
	const processor = cpus()[0]?.model ?? "unknown";
	const normalized = processor
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
	return `${platform()}-${arch()}-${normalized}-${release().split(".")[0]}`;
};

export const summarizePowerBenchmarkRuns = (input: {
	readonly runs: ReadonlyArray<PowerBenchmarkRun>;
	readonly baseline?: PowerBenchmarkAggregate;
}): PowerBenchmarkAggregate => {
	const first = input.runs[0];
	if (first === undefined)
		throw new Error("At least one benchmark run is required.");
	if (input.runs.length !== 3) {
		throw new Error("Reference benchmarks require exactly three runs.");
	}
	if (input.runs.some((run) => run.scenario !== first.scenario)) {
		throw new Error("Benchmark runs must use the same scenario.");
	}
	const electron = input.runs.map((run) => run.averageElectronCpuPercent);
	const tree = input.runs.map((run) => run.averageProcessTreeCpuPercent);
	const memory = input.runs.map((run) => run.averageProcessTreeMemoryBytes);
	const medians = {
		electronCpuPercent: round(median(electron)),
		processTreeCpuPercent: round(median(tree)),
		processTreeMemoryBytes: Math.round(median(memory)),
	};
	const baseline = input.baseline?.median;
	return {
		schemaVersion: 1,
		machineClass: referenceMachineClass(),
		scenario: first.scenario,
		runs: input.runs,
		median: medians,
		range: {
			electronCpuPercent: range(electron),
			processTreeCpuPercent: range(tree),
			processTreeMemoryBytes: range(memory),
		},
		baselineDelta:
			baseline === undefined
				? null
				: {
						electronCpuPercent: round(
							medians.electronCpuPercent - baseline.electronCpuPercent,
						),
						processTreeCpuPercent: round(
							medians.processTreeCpuPercent - baseline.processTreeCpuPercent,
						),
						processTreeMemoryBytes:
							medians.processTreeMemoryBytes - baseline.processTreeMemoryBytes,
					},
		energyAttributionNote:
			"Battery percentage and Energy Log values describe the whole Mac. They are not attributed exclusively to Zuse. Use Instruments Energy Log or powermetrics on a controlled reference machine.",
	};
};

const formatMib = (bytes: number): string =>
	`${(bytes / 1024 ** 2).toFixed(1)} MiB`;

export const powerBenchmarkMarkdown = (
	report: PowerBenchmarkAggregate,
): string => `# Desktop power benchmark

- Machine class: ${report.machineClass}
- Scenario: ${report.scenario}
- Runs: ${report.runs.length}
- Samples: ${report.runs.map((run) => run.sampleCount).join(", ")}

| Metric | Median | Range |
| --- | ---: | ---: |
| Electron CPU | ${report.median.electronCpuPercent.toFixed(2)}% | ${report.range.electronCpuPercent[0].toFixed(2)}–${report.range.electronCpuPercent[1].toFixed(2)}% |
| Full process-tree CPU | ${report.median.processTreeCpuPercent.toFixed(2)}% | ${report.range.processTreeCpuPercent[0].toFixed(2)}–${report.range.processTreeCpuPercent[1].toFixed(2)}% |
| Full process-tree memory | ${formatMib(report.median.processTreeMemoryBytes)} | ${formatMib(report.range.processTreeMemoryBytes[0])}–${formatMib(report.range.processTreeMemoryBytes[1])} |

${report.baselineDelta === null ? "No baseline was supplied. This report is descriptive." : `Baseline delta: Electron CPU ${report.baselineDelta.electronCpuPercent.toFixed(2)} points, process-tree CPU ${report.baselineDelta.processTreeCpuPercent.toFixed(2)} points, memory ${formatMib(report.baselineDelta.processTreeMemoryBytes)}.`}

> ${report.energyAttributionNote}
`;

export const writePowerBenchmarkReport = async (input: {
	readonly directory: string;
	readonly report: PowerBenchmarkAggregate;
}): Promise<{ readonly jsonPath: string; readonly markdownPath: string }> => {
	await mkdir(input.directory, { recursive: true });
	const prefix = `${input.report.machineClass}-${input.report.scenario}`;
	const jsonPath = join(input.directory, `${prefix}.json`);
	const markdownPath = join(input.directory, `${prefix}.md`);
	await Promise.all([
		writeFile(jsonPath, `${JSON.stringify(input.report, null, 2)}\n`, "utf8"),
		writeFile(markdownPath, powerBenchmarkMarkdown(input.report), "utf8"),
	]);
	return { jsonPath, markdownPath };
};

const powerBenchmarkBaselinePath = (input: {
	readonly directory: string;
	readonly machineClass: string;
	readonly scenario: PowerBenchmarkScenario;
}): string =>
	join(input.directory, input.machineClass, `${input.scenario}.json`);

export const readPowerBenchmarkBaseline = async (input: {
	readonly directory: string;
	readonly machineClass: string;
	readonly scenario: PowerBenchmarkScenario;
}): Promise<PowerBenchmarkAggregate | null> => {
	try {
		const value = JSON.parse(
			await readFile(powerBenchmarkBaselinePath(input), "utf8"),
		) as Partial<PowerBenchmarkAggregate>;
		if (
			value.schemaVersion !== 1 ||
			value.machineClass !== input.machineClass ||
			value.scenario !== input.scenario ||
			value.median === undefined
		) {
			throw new Error("The performance baseline does not match this machine.");
		}
		return value as PowerBenchmarkAggregate;
	} catch (cause) {
		if (
			typeof cause === "object" &&
			cause !== null &&
			"code" in cause &&
			cause.code === "ENOENT"
		) {
			return null;
		}
		throw cause;
	}
};

export const writePowerBenchmarkBaseline = async (input: {
	readonly directory: string;
	readonly report: PowerBenchmarkAggregate;
}): Promise<string> => {
	const path = powerBenchmarkBaselinePath({
		directory: input.directory,
		machineClass: input.report.machineClass,
		scenario: input.report.scenario,
	});
	await mkdir(join(input.directory, input.report.machineClass), {
		recursive: true,
	});
	await writeFile(path, `${JSON.stringify(input.report, null, 2)}\n`, "utf8");
	return path;
};
