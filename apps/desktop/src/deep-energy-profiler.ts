import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
	DeepEnergySummary,
	PowerRecordingDurationMinutes,
} from "@zuse/contracts";

const average = (values: ReadonlyArray<number>): number | null =>
	values.length === 0
		? null
		: Math.round(
				(values.reduce((total, value) => total + value, 0) / values.length) *
					10,
			) / 10;

const readings = (output: string, label: string): number[] => {
	const expression = new RegExp(
		`${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:?\\s*([\\d.]+)\\s*mW`,
		"gi",
	);
	return [...output.matchAll(expression)].flatMap((match) => {
		const value = Number(match[1]);
		return Number.isFinite(value) ? [value] : [];
	});
};

export function parseDeepEnergyOutput(output: string): DeepEnergySummary {
	const cpuPowerMw = average(readings(output, "CPU Power"));
	const gpuPowerMw = average(readings(output, "GPU Power"));
	const anePowerMw = average(readings(output, "ANE Power"));
	const combinedPowerMw = average(
		readings(output, "Combined Power (CPU + GPU + ANE)"),
	);
	const pressure = /Current pressure level:\s*([A-Za-z]+)/i
		.exec(output)?.[1]
		?.toLowerCase();
	if (
		cpuPowerMw === null &&
		gpuPowerMw === null &&
		anePowerMw === null &&
		combinedPowerMw === null
	) {
		return {
			status: "unavailable",
			cpuPowerMw: null,
			gpuPowerMw: null,
			anePowerMw: null,
			combinedPowerMw: null,
			reason: "The system profiler did not return energy readings.",
		};
	}
	return {
		status: "complete",
		cpuPowerMw,
		gpuPowerMw,
		anePowerMw,
		combinedPowerMw,
		...(pressure === undefined ? {} : { thermalPressure: pressure }),
	};
}

export interface DeepEnergyProfileHandle {
	readonly completion: Promise<DeepEnergySummary>;
	readonly cancel: () => void;
}

const unavailable = (reason: string): DeepEnergySummary => ({
	status: "unavailable",
	cpuPowerMw: null,
	gpuPowerMw: null,
	anePowerMw: null,
	combinedPowerMw: null,
	reason,
});

const shellQuote = (value: string): string =>
	`'${value.replaceAll("'", "'\\''")}'`;

export async function startDeepEnergyProfile(
	durationMinutes: PowerRecordingDurationMinutes,
	tempRoot: string,
): Promise<DeepEnergyProfileHandle> {
	if (process.platform !== "darwin") {
		return {
			completion: Promise.resolve(
				unavailable("Deep energy profiling is available on macOS only."),
			),
			cancel: () => undefined,
		};
	}
	const directory = await mkdtemp(join(tempRoot, "zuse-energy-"));
	const outputPath = join(directory, "powermetrics.txt");
	const pidPath = join(directory, "powermetrics.pid");
	const sampleRateMs = 5_000;
	const sampleCount = Math.max(
		1,
		Math.ceil((durationMinutes * 60_000) / sampleRateMs),
	);
	const profilerCommand = [
		"exec /usr/bin/powermetrics",
		"--sample-rate",
		String(sampleRateMs),
		"--sample-count",
		String(sampleCount),
		"--samplers",
		"tasks,battery,network,disk,cpu_power,thermal,gpu_power,ane_power",
		"--show-process-energy",
		"--show-process-io",
		"--show-process-netstats",
		"--handle-invalid-values",
		"--format",
		"text",
		"--output-file",
		shellQuote(outputPath),
	].join(" ");
	const command = [
		`/bin/echo $$ > ${shellQuote(pidPath)}`,
		profilerCommand,
	].join(" && ");
	const appleScriptCommand = command
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"');
	let child: ChildProcess | null = spawn(
		"/usr/bin/osascript",
		[
			"-e",
			`do shell script "${appleScriptCommand}" with administrator privileges`,
		],
		{ stdio: "ignore" },
	);
	let cancelled = false;
	const terminateProfiler = async (): Promise<void> => {
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const pid = Number.parseInt(
				await readFile(pidPath, "utf8").catch(() => ""),
				10,
			);
			if (Number.isSafeInteger(pid) && pid > 1) {
				const killCommand = `/bin/kill -TERM ${pid}`;
				const escapedKillCommand = killCommand
					.replaceAll("\\", "\\\\")
					.replaceAll('"', '\\"');
				spawn(
					"/usr/bin/osascript",
					[
						"-e",
						`do shell script "${escapedKillCommand}" with administrator privileges`,
					],
					{ detached: true, stdio: "ignore" },
				).unref();
				return;
			}
			await delay(50);
		}
	};
	const completion = new Promise<DeepEnergySummary>((resolve) => {
		child?.once("error", (error) => {
			resolve(unavailable(error.message));
		});
		child?.once("close", async (code) => {
			try {
				if (cancelled) {
					resolve({
						status: "cancelled",
						cpuPowerMw: null,
						gpuPowerMw: null,
						anePowerMw: null,
						combinedPowerMw: null,
					});
					return;
				}
				if (code !== 0) {
					resolve(
						unavailable(
							"System energy profiling was cancelled or authorization was denied.",
						),
					);
					return;
				}
				resolve(parseDeepEnergyOutput(await readFile(outputPath, "utf8")));
			} catch {
				resolve(unavailable("The system energy profile could not be read."));
			} finally {
				child = null;
				await rm(directory, { recursive: true, force: true }).catch(
					() => undefined,
				);
			}
		});
	});
	return {
		completion,
		cancel: () => {
			cancelled = true;
			void terminateProfiler();
			child?.kill("SIGTERM");
		},
	};
}
