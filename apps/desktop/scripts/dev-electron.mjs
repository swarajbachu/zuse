// Dev runner: waits for the Vite dev server + bundled main/preload, then spawns
// Electron pointing at them. Restarts Electron on rebuilds. Slimmed down:
// no cross-app server checks, no macOS app-bundle renaming.

import { spawn, spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const desktopOutDir = resolve(
	process.env.ZUSE_DESKTOP_OUT_DIR?.trim() || join(desktopDir, "dist-electron"),
);

// Default matches apps/renderer/vite.config.ts. waitForResources() below polls
// the port until vite comes up, so the boot order across `bun run dev` (turbo
// runs renderer + desktop in parallel) and `bun run dev:desktop` (the root
// orchestrator script) both work without explicit synchronization.
const devServerUrl =
	process.env.VITE_DEV_SERVER_URL?.trim() || "http://localhost:5733";
const devServer = new URL(devServerUrl);
const devPort = Number.parseInt(devServer.port, 10);
if (!Number.isInteger(devPort) || devPort <= 0) {
	throw new Error(`VITE_DEV_SERVER_URL must include a port: ${devServerUrl}`);
}

const requiredFiles = [
	join(desktopOutDir, "main.cjs"),
	join(desktopOutDir, "preload.cjs"),
];
// One tsdown rebuild flushes several outputs (main, preload, MCP children)
// spread over a couple of seconds — the debounce must span the whole flush so
// a rebuild produces ONE restart, not one per file. Too-short debounce plus a
// tight kill timeout caused the SIGTERM→SIGKILL restart churn that also hard
// killed the embedded server (dropping every paired phone mid-session).
const restartDebounceMs = 1_000;
const forcedShutdownTimeoutMs = 5_000;

let shuttingDown = false;
let restartTimer = null;
let currentApp = null;
let restartQueue = Promise.resolve();
const expectedExits = new WeakSet();

async function fileExists(p) {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

function tcpReady(host, port, timeoutMs = 500) {
	return new Promise((resolveReady) => {
		const socket = createConnection({ host, port });
		let settled = false;
		const finish = (ready) => {
			if (settled) return;
			settled = true;
			socket.removeAllListeners();
			socket.destroy();
			resolveReady(ready);
		};
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(false));
		socket.once("error", () => finish(false));
		socket.setTimeout(timeoutMs);
	});
}

async function waitForResources({
	timeoutMs = 120_000,
	intervalMs = 100,
} = {}) {
	console.log(
		`[desktop:electron] waiting for ${devServerUrl} and ${requiredFiles.join(", ")}`,
	);
	const startedAt = Date.now();
	while (true) {
		const filesReady = await Promise.all(
			requiredFiles.map((path) => fileExists(path)),
		).then((results) => results.every(Boolean));
		const portReady = await tcpReady(
			devServer.hostname || "127.0.0.1",
			devPort,
		);
		if (filesReady && portReady) {
			console.log("[desktop:electron] resources ready");
			return;
		}
		if (Date.now() - startedAt >= timeoutMs) {
			throw new Error(
				`Timed out waiting for dev resources (port ${devPort}, files ${requiredFiles.join(", ")})`,
			);
		}
		await delay(intervalMs);
	}
}

function killChildTreeByPid(pid, signal) {
	if (process.platform === "win32" || typeof pid !== "number") return;
	spawnSync("pkill", [`-${signal}`, "-P", String(pid)], { stdio: "ignore" });
}

function startApp() {
	if (shuttingDown || currentApp !== null) return;

	const electronPath = require("electron");
	console.log(`[desktop:electron] launching ${electronPath}`);
	const app = spawn(
		electronPath,
		[join(desktopOutDir, "main.cjs"), "--memoize-dev"],
		{
			cwd: desktopDir,
			// Pass the resolved dev URL through explicitly so main.ts sees it even
			// when bun/turbo invoked us without setting the env var.
			env: { ...process.env, VITE_DEV_SERVER_URL: devServerUrl },
			stdio: "inherit",
		},
	);
	currentApp = app;

	app.once("error", (error) => {
		console.error("[desktop:electron] failed to launch", error);
		if (currentApp === app) currentApp = null;
		if (!shuttingDown) void shutdown(1);
	});

	app.once("exit", (code, signal) => {
		console.log(
			`[desktop:electron] exited (code=${code ?? "null"} signal=${signal ?? "null"})`,
		);
		if (currentApp === app) currentApp = null;
		const abnormal = signal !== null || code !== 0;
		if (!shuttingDown && !expectedExits.has(app) && abnormal) {
			void shutdown(code ?? 1);
		}
	});
}

async function stopApp() {
	const app = currentApp;
	if (!app) return;
	currentApp = null;
	expectedExits.add(app);

	await new Promise((resolveStop) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			resolveStop();
		};
		app.once("exit", finish);
		app.kill("SIGTERM");
		killChildTreeByPid(app.pid, "TERM");
		setTimeout(() => {
			if (settled) return;
			app.kill("SIGKILL");
			killChildTreeByPid(app.pid, "KILL");
			finish();
		}, forcedShutdownTimeoutMs).unref();
	});
}

function scheduleRestart() {
	if (shuttingDown) return;
	if (restartTimer) clearTimeout(restartTimer);
	restartTimer = setTimeout(() => {
		restartTimer = null;
		restartQueue = restartQueue
			.catch(() => undefined)
			.then(async () => {
				await stopApp();
				if (!shuttingDown) startApp();
			});
	}, restartDebounceMs);
}

function startWatcher() {
	const watchedFiles = new Set(["main.cjs", "preload.cjs"]);
	return watch(desktopOutDir, { persistent: true }, (_event, filename) => {
		if (typeof filename === "string" && watchedFiles.has(filename))
			scheduleRestart();
	});
}

async function shutdown(code) {
	if (shuttingDown) return;
	shuttingDown = true;
	if (restartTimer) clearTimeout(restartTimer);
	await stopApp();
	process.exit(code);
}

await waitForResources();
const watcher = startWatcher();
startApp();

const onSignal = (code) => () => {
	watcher.close();
	void shutdown(code);
};
process.once("SIGINT", onSignal(130));
process.once("SIGTERM", onSignal(143));
process.once("SIGHUP", onSignal(129));
