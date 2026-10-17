import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, freemem, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { makeBoundedTextBuffer } from "@zuse/testkit";
import { stopOwnedProcess } from "@zuse/utils/owned-process";
import {
	connectLocalEngine,
	readEngineEndpoint,
	requestIdleEngineShutdown,
} from "@zusehq/server/desktop-engine";
import { sanitizeRemoteConnectionLog } from "../../../apps/desktop/src/remote-diagnostic-sanitizer.ts";
import {
	descendantProcessTree,
	type ProcessTreeMetric,
	readProcessTreeSnapshot,
} from "../src/power-benchmark.ts";

assert.ok(
	["win32", "linux"].includes(process.platform),
	"Run on Windows or Linux for development-runner parity checks",
);
const output = resolve(".context/windows/dev");
await mkdir(output, { recursive: true });
const probe = spawnSync("bun", ["run", "dev", "--dry-run"], {
	encoding: "utf8",
	timeout: 30_000,
});
assert.equal(probe.status, 0, probe.stderr);
const instance = `windows-smoke-${process.pid}`;
const userData = resolve(".zuse/dev-instances", instance, "user-data");
for (let run = 0; run < 2; run++) {
	const log = makeBoundedTextBuffer(256 * 1024);
	const startedAt = Date.now();
	const child = fork("scripts/dev.mjs", ["--instance", instance], {
		execArgv: ["--import", "tsx"],
		stdio: ["ignore", "pipe", "pipe", "ipc"],
		env: { ...process.env, ZUSE_DISABLE_DEEP_ENERGY_PROFILE: "1" },
	});
	child.stdout?.on("data", (data) => log.append(String(data)));
	child.stderr?.on("data", (data) => log.append(String(data)));
	let failure: Error | undefined;
	child.once("error", (error) => {
		failure = error;
	});
	const exited = new Promise<void>((done) => child.once("exit", () => done()));
	const samples: {
		elapsedMs: number;
		freeMemoryBytes: number;
		processes: readonly ProcessTreeMetric[];
	}[] = [];
	const observed = new Map<number, number | undefined>();
	let readyMs: number | undefined;
	let success = false;
	const cleanupErrors: string[] = [];
	try {
		while (Date.now() - startedAt < 180_000) {
			if (failure) throw failure;
			assert.equal(
				child.exitCode,
				null,
				`Development process exited: ${child.exitCode}`,
			);
			assert.equal(
				child.signalCode,
				null,
				`Development process signalled: ${child.signalCode}`,
			);
			const processes = descendantProcessTree(
				await readProcessTreeSnapshot(),
				child.pid ?? -1,
			);
			for (const item of processes) observed.set(item.pid, item.startedAtMs);
			samples.push({
				elapsedMs: Date.now() - startedAt,
				freeMemoryBytes: freemem(),
				processes,
			});
			const endpoint = await readEngineEndpoint(userData);
			if (endpoint) {
				const channel = await connectLocalEngine(endpoint, {
					receive: () => {},
					signal: AbortSignal.timeout(5_000),
				});
				channel.close();
				await channel.closed;
				readyMs = Date.now() - startedAt;
				break;
			}
			await delay(2_000);
		}
		assert.notEqual(
			readyMs,
			undefined,
			"Development engine did not become ready within 180 seconds",
		);
		// The engine is deliberately persistent across shell restarts. Stop it through
		// its authenticated idle-shutdown protocol, never kill a user's active engine.
		child.send({ type: "zuse:dev-shutdown" });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				exited,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("Development shutdown timed out")),
						12_000,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
		assert.equal(child.exitCode, 0);
		success = true;
	} catch (error) {
		failure = error instanceof Error ? error : new Error(String(error));
		throw error;
	} finally {
		// Preserve diagnostics even when cleanup itself fails.
		try {
			if (child.exitCode === null && child.signalCode === null)
				await stopOwnedProcess(child);
		} catch (error) {
			cleanupErrors.push(String(error));
		}
		try {
			const endpoint = await readEngineEndpoint(userData);
			if (endpoint)
				assert.equal(
					await requestIdleEngineShutdown(endpoint, { userData }),
					"stopped",
				);
		} catch (error) {
			cleanupErrors.push(String(error));
		}
		const survivors = (await readProcessTreeSnapshot()).filter(
			(item) =>
				observed.has(item.pid) && observed.get(item.pid) === item.startedAtMs,
		);
		await writeFile(
			resolve(output, `run-${run}.log`),
			sanitizeRemoteConnectionLog(log.read()),
		);
		await writeFile(
			resolve(output, `run-${run}.json`),
			JSON.stringify(
				{
					success:
						success && cleanupErrors.length === 0 && survivors.length === 0,
					error: failure?.message,
					cleanupErrors,
					readyMs,
					exitCode: child.exitCode,
					signal: child.signalCode,
					platform: process.platform,
					os: release(),
					cpuCount: cpus().length,
					totalMemoryBytes: totalmem(),
					samples,
					survivors,
				},
				null,
				2,
			),
		);
		assert.deepEqual(cleanupErrors, [], "Development cleanup failed");
		assert.deepEqual(
			survivors,
			[],
			"Observed development processes survived shutdown",
		);
	}
}
