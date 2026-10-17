import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, freemem, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PowerMonitorState } from "@zuse/contracts";
import { readEngineEndpoint } from "@zusehq/server/desktop-engine";
import { _electron } from "playwright-core";
import { closeElectronApplication } from "../src/electron-app.ts";
import { waitForEngineEndpoint } from "../src/engine-readiness.ts";
import {
	descendantProcessTree,
	readProcessTreeSnapshot,
} from "../src/power-benchmark.ts";

// Runs the installed application; the operator exercises a real agent and terminal.
// Baseline capture is not a passing qualification. A subsequent run needs budgets.
const [executable, profile, budgetFile] = process.argv.slice(2);
assert.ok(
	executable && profile,
	"Usage: windows-soak.ts <installed.exe> <test-profile> [budgets.json]",
);
assert.equal(process.platform, "win32");
assert.ok(
	Number(release().split(".")[2]) >= 22000,
	"Qualification requires Windows 11",
);
assert.ok(
	totalmem() <= 4.5 * 1024 ** 3,
	"Use a Windows machine limited to 4 GB RAM",
);
assert.ok(cpus().length <= 2, "Use a VM limited to two logical processors");
const output = resolve(".context/windows/soak");
await mkdir(output, { recursive: true });
const budgets = budgetFile
	? JSON.parse(await readFile(budgetFile, "utf8"))
	: undefined;
if (budgets)
	for (const key of [
		"peakWorkingSetBytes",
		"workingSetGrowthBytes",
		"p95RendererProbeMs",
	]) {
		assert.ok(
			typeof budgets[key] === "number" &&
				Number.isFinite(budgets[key]) &&
				budgets[key] > 0,
			`Missing positive budget: ${key}`,
		);
	}
const app = await _electron.launch({
	executablePath: resolve(executable),
	env: {
		...process.env,
		ZUSE_USER_DATA_DIR: resolve(profile),
		ZUSE_DISABLE_DEEP_ENERGY_PROFILE: "1",
	},
});
const samples: {
	elapsedMs: number;
	workingSetBytes: number;
	freeMemoryBytes: number;
	rendererProbeMs: number;
	activeAgents: number;
	activeTerminals: number;
	pids: number[];
}[] = [];
let completed = false;
let crashed = false;
const startedAt = Date.now();
try {
	const page = await app.firstWindow();
	page.on("crash", () => {
		crashed = true;
	});
	await page.waitForFunction(
		"typeof window.zuse?.power?.getState === 'function'",
		undefined,
		{ timeout: 30_000 },
	);
	console.log(
		"Exercise one real agent, terminal output, and a long conversation for one hour. Reports contain metrics only. Baseline runs do not qualify a release.",
	);
	await waitForEngineEndpoint(resolve(profile));
	const samplingStartedAt = Date.now();
	while (Date.now() - samplingStartedAt < 60 * 60 * 1000) {
		assert.equal(crashed, false, "Renderer crashed");
		assert.equal(
			app.process().exitCode,
			null,
			"Application exited during soak",
		);
		const probeStarted = performance.now();
		let probeTimer: ReturnType<typeof setTimeout> | undefined;
		let state: PowerMonitorState;
		try {
			state = await Promise.race([
				page.evaluate<PowerMonitorState>("window.zuse.power.getState()"),
				new Promise<never>((_, reject) => {
					probeTimer = setTimeout(
						() => reject(new Error("Renderer stopped responding")),
						15_000,
					);
				}),
			]);
		} finally {
			clearTimeout(probeTimer);
		}
		const rendererProbeMs = performance.now() - probeStarted;
		const endpoint = await readEngineEndpoint(resolve(profile));
		assert.ok(endpoint, "Engine endpoint disappeared");
		const snapshot = await readProcessTreeSnapshot();
		const pids = new Set(
			[
				...descendantProcessTree(snapshot, app.process().pid ?? -1),
				...descendantProcessTree(
					snapshot,
					endpoint.supervisorPid ?? endpoint.pid,
				),
			].map((item) => item.pid),
		);
		assert.ok(pids.has(endpoint.pid), "Engine process disappeared");
		samples.push({
			elapsedMs: Date.now() - startedAt,
			workingSetBytes: snapshot
				.filter((item) => pids.has(item.pid))
				.reduce((sum, item) => sum + item.residentMemoryBytes, 0),
			freeMemoryBytes: freemem(),
			rendererProbeMs,
			activeAgents: state.latestSnapshot?.workload.activeAgents ?? 0,
			activeTerminals: state.latestSnapshot?.workload.activeTerminals ?? 0,
			pids: [...pids],
		});
		await writeFile(join(output, "samples.json"), JSON.stringify(samples));
		await delay(10_000);
	}
	assert.ok(
		samples.some((item) => item.activeAgents > 0),
		"No active agent was observed",
	);
	assert.ok(
		samples.some((item) => item.activeTerminals > 0),
		"No active terminal was observed",
	);
	const mean = (items: typeof samples) =>
		items.reduce((sum, item) => sum + item.workingSetBytes, 0) / items.length;
	const peakWorkingSetBytes = Math.max(
		...samples.map((item) => item.workingSetBytes),
	);
	const workingSetGrowthBytes =
		mean(samples.slice(-30)) - mean(samples.slice(0, 30));
	const latencies = samples
		.map((item) => item.rendererProbeMs)
		.sort((a, b) => a - b);
	const p95RendererProbeMs =
		latencies[
			Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))
		];
	const measurements = {
		peakWorkingSetBytes,
		workingSetGrowthBytes,
		p95RendererProbeMs,
	};
	await writeFile(
		join(output, "summary.json"),
		JSON.stringify(
			{
				mode: budgets ? "budget-check" : "baseline-only",
				os: release(),
				totalMemoryBytes: totalmem(),
				cpuCount: cpus().length,
				measurements,
				budgets,
				durationMs: Date.now() - startedAt,
			},
			null,
			2,
		),
	);
	if (budgets) {
		assert.ok(
			peakWorkingSetBytes <= budgets.peakWorkingSetBytes,
			"Peak memory exceeds baseline budget",
		);
		assert.ok(
			workingSetGrowthBytes <= budgets.workingSetGrowthBytes,
			"Memory growth exceeds baseline budget",
		);
		assert.ok(
			p95RendererProbeMs !== undefined &&
				p95RendererProbeMs <= budgets.p95RendererProbeMs,
			"Renderer responsiveness exceeds baseline budget",
		);
	}
	completed = true;
} finally {
	await writeFile(
		join(output, "status.json"),
		JSON.stringify({
			completed,
			crashed,
			baselineOnly: !budgets,
			elapsedMs: Date.now() - startedAt,
		}),
	);
	await closeElectronApplication(app);
	// The persistent engine may still own a real user's active turn. Do not kill it.
}
