/**
 * Opt-in live benchmark. Creates a disposable Box and boots the published Zuse
 * server without account linking. This measures server health, not chat recovery.
 * Run with Bun; see internal-docs/cloud/box-resume-benchmark.md.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect, Redacted } from "effect";
import type { makeBoxSandboxProvider as MakeBoxProvider } from "../../packages/sandbox-providers/src/box.ts";

const key = process.env.BOX_API_KEY;
const snapshot = process.env.BOX_TEMPLATE_SNAPSHOT;
if (!key || !snapshot)
	throw new Error("BOX_API_KEY and BOX_TEMPLATE_SNAPSHOT are required");
const variant = process.env.BOX_BENCH_VARIANT ?? "current";
const output =
	process.env.BOX_BENCH_OUTPUT ??
	`.context/box-resume-benchmark/${variant}.json`;
const rounds = Number(process.env.BOX_BENCH_ROUNDS ?? 3);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10)
	throw new Error("BOX_BENCH_ROUNDS must be 1..10");
const modulePath = process.env.BOX_BENCH_ADAPTER
	? pathToFileURL(resolve(process.env.BOX_BENCH_ADAPTER)).href
	: new URL("../../packages/sandbox-providers/src/box.ts", import.meta.url)
			.href;
const { makeBoxSandboxProvider } = (await import(modulePath)) as {
	makeBoxSandboxProvider: typeof MakeBoxProvider;
};
const api = async (method: string, path: string, body?: unknown) => {
	const response = await fetch(`https://boat.dev/api/v1${path}`, {
		method,
		redirect: "error",
		headers: {
			authorization: `Bearer ${key}`,
			"content-type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(90_000),
	});
	if (!response.ok)
		throw new Error(`Box ${method} ${path}: ${response.status}`);
	return (await response.json()) as {
		sandbox?: { id: string; name?: string; state: string };
		exitCode?: number;
	};
};
const adapter = makeBoxSandboxProvider({
	apiKey: Redacted.make(key),
	templateSnapshot: snapshot,
	templateVersion: "benchmark",
	machineType: "small",
});
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const samples: Array<Record<string, string | number>> = [];
await mkdir(dirname(output), { recursive: true });
let sandboxId: string | undefined;
let activeRound = 0;
const setupStart = performance.now();
try {
	let id = process.env.BOX_BENCH_REUSE_ID;
	if (id) {
		const detail = await api("GET", `/sandboxes/${encodeURIComponent(id)}`);
		if (!detail.sandbox?.name?.startsWith("zuse-resume-benchmark-"))
			throw new Error("Refusing to pause a non-benchmark Box");
		sandboxId = id;
		if (detail.sandbox.state === "archived")
			await Effect.runPromise(adapter.resume(id, 3600, "pause", "small"));
	} else {
		const created = await Effect.runPromise(
			adapter.create({
				sandboxId: crypto.randomUUID(),
				providerLabel: `zuse-resume-benchmark-${Date.now()}`,
				timeoutSeconds: 3600,
				env: {},
				network: { kind: "open" },
				onTimeout: "pause",
			}),
		);
		id = created.providerSandboxId;
	}
	sandboxId = id;
	const targetId = id;
	console.log(`Benchmark Box: ${sandboxId}`);
	const launch = () =>
		Effect.runPromise(
			adapter.replaceProcess(
				targetId,
				{
					tag: "zuse-runtime",
					legacyCommandMarkers: [
						"/usr/local/bin/zuse serve",
						"/opt/zuse/current/bin.mjs serve",
					],
				},
				{
					command: "/bin/bash",
					args: [
						"-lc",
						"mkdir -p /var/lib/zuse/workspace; exec /usr/local/bin/zuse serve --foreground --no-account > /var/lib/zuse/workspace/benchmark-runtime.log 2>&1",
					],
					cwd: "/home/zuse",
					user: "zuse",
					env: {
						ZUSE_HOST: "127.0.0.1",
						ZUSE_PORT: "47837",
						ZUSE_AUTH_POLICY: "local",
						ZUSE_ENABLE_PAIRING: "0",
						ZUSE_SERVER_READY_STDOUT: "1",
						ZUSE_USER_DATA: "/home/zuse/.zuse-benchmark-data",
					},
				},
			),
		);
	const health = async (poll: boolean) => {
		const command = poll
			? "for i in $(seq 1 120); do if curl -fsS --max-time 1 http://127.0.0.1:47837/healthz >/dev/null 2>&1; then exit 0; fi; sleep 0.25; done; exit 1"
			: "curl -fsS --max-time 2 http://127.0.0.1:47837/healthz >/dev/null";
		const result = await api("POST", `/sandboxes/${sandboxId}/commands`, {
			command,
			timeoutSeconds: 40,
		});
		if (result.exitCode !== 0)
			throw new Error("Zuse server health check failed");
	};
	await Effect.runPromise(adapter.setNetwork(sandboxId, { kind: "open" }));
	await launch();
	await health(true);
	for (let round = 1; round <= rounds; round++) {
		activeRound = round;
		const roundStart = performance.now();
		try {
			await wait(3000);
			await health(false);
			console.log(`Round ${round}: archiving`);
			await Effect.runPromise(adapter.pause(sandboxId));
			let archived = false;
			for (let poll = 0; poll < 180; poll++) {
				if (
					(await api("GET", `/sandboxes/${sandboxId}`)).sandbox?.state ===
					"archived"
				) {
					archived = true;
					break;
				}
				await wait(1000);
			}
			if (!archived)
				throw new Error("Box did not archive within the polling deadline");
			console.log(`Round ${round}: resuming`);
			const start = performance.now();
			await Effect.runPromise(
				adapter.resume(sandboxId, 3600, "pause", "small"),
			);
			const resumed = performance.now();
			let networkRetries = 0;
			for (;;) {
				try {
					await Effect.runPromise(
						adapter.setNetwork(sandboxId, { kind: "open" }),
					);
					break;
				} catch (error) {
					if (++networkRetries >= 10) throw error;
					await wait(1000);
				}
			}
			const network = performance.now();
			await launch();
			const launched = performance.now();
			await health(true);
			const ready = performance.now();
			await wait(3000);
			await health(false);
			const sample = {
				variant,
				round,
				sandboxId,
				status: "ready",
				networkRetries,
				resumeMs: resumed - start,
				networkMs: network - resumed,
				launchMs: launched - network,
				runtimeReadyMs: ready - launched,
				totalMs: ready - start,
			};
			samples.push(sample);
			console.log(JSON.stringify(sample));
		} catch (error) {
			samples.push({
				variant,
				round,
				sandboxId,
				status: "failed",
				elapsedMs: performance.now() - roundStart,
			});
			throw error;
		} finally {
			await writeFile(output, `${JSON.stringify(samples, null, 2)}\n`);
		}
	}
} catch (error) {
	if (activeRound === 0) {
		samples.push({
			variant,
			round: 0,
			phase: "setup",
			...(sandboxId ? { sandboxId } : {}),
			status: "failed",
			elapsedMs: performance.now() - setupStart,
		});
		await writeFile(output, `${JSON.stringify(samples, null, 2)}\n`);
	}
	throw error;
} finally {
	if (sandboxId !== undefined) {
		if (process.env.BOX_BENCH_KEEP === "1")
			await Effect.runPromise(adapter.pause(sandboxId));
		else await Effect.runPromise(adapter.kill(sandboxId));
	}
}
