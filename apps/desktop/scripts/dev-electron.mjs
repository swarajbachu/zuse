import { spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import deploymentProfiles from "../../../packages/contracts/src/deployment-profiles.json" with {
	type: "json",
};

import { signalDevApp, spawnDevApp } from "./dev-app-process.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const desktopOutDir = resolve(
	process.env.ZUSE_DESKTOP_OUT_DIR?.trim() || join(desktopDir, "dist-electron"),
);

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

function buildNativeHelpers() {
	const result = spawnSync(
		process.execPath,
		[join(desktopDir, "scripts", "build-local-connectivity-helper.mjs")],
		{
			cwd: desktopDir,
			stdio: "inherit",
			env: process.env,
		},
	);
	if (result.status !== 0) {
		throw new Error(
			`Native helper build failed (status ${result.status ?? "unknown"})`,
		);
	}
}
const configuredDevStartedAt = Number(process.env.ZUSE_DEV_STARTED_AT);
const devStartedAt = Number.isFinite(configuredDevStartedAt)
	? configuredDevStartedAt
	: Date.now();
const configuredStartupTimeoutMs = Number(
	process.env.ZUSE_DEV_STARTUP_TIMEOUT_MS,
);
const startupTimeoutMs =
	Number.isFinite(configuredStartupTimeoutMs) && configuredStartupTimeoutMs > 0
		? configuredStartupTimeoutMs
		: 300_000;

const restartDebounceMs = 1_000;
const forcedShutdownTimeoutMs = 5_000;

let shuttingDown = false;
let restartTimer = null;
let currentApp = null;
let restartQueue = Promise.resolve();
const expectedExits = new WeakSet();

async function inspectFile(p) {
	try {
		const { mtimeMs } = await stat(p);
		return { path: p, ready: mtimeMs >= devStartedAt, mtimeMs };
	} catch {
		return { path: p, ready: false, mtimeMs: null };
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
	timeoutMs = startupTimeoutMs,
	intervalMs = 100,
	statusIntervalMs = 10_000,
} = {}) {
	console.log(
		`[desktop:electron] waiting for ${devServerUrl} and current-run artifacts ${requiredFiles.join(", ")}`,
	);
	const startedAt = Date.now();
	let nextStatusAt = startedAt + statusIntervalMs;
	while (true) {
		const fileStates = await Promise.all(requiredFiles.map(inspectFile));
		const filesReady = fileStates.every(({ ready }) => ready);
		const portReady = await tcpReady(
			devServer.hostname || "127.0.0.1",
			devPort,
		);
		if (filesReady && portReady) {
			console.log("[desktop:electron] resources ready");
			return;
		}
		const pending = [];
		if (!portReady)
			pending.push(`renderer ${devServerUrl} is not accepting connections`);
		for (const state of fileStates) {
			if (state.ready) continue;
			pending.push(
				state.mtimeMs === null
					? `artifact is missing: ${state.path}`
					: `artifact is stale: ${state.path} (modified ${new Date(state.mtimeMs).toISOString()})`,
			);
		}
		const now = Date.now();
		if (now >= nextStatusAt) {
			console.log(
				`[desktop:electron] still waiting after ${Math.round((now - startedAt) / 1_000)}s:\n- ${pending.join("\n- ")}`,
			);
			nextStatusAt = now + statusIntervalMs;
		}
		if (now - startedAt >= timeoutMs) {
			throw new Error(
				`Timed out after ${Math.round(timeoutMs / 1_000)}s waiting for dev resources:\n- ${pending.join("\n- ")}`,
			);
		}
		await delay(intervalMs);
	}
}

function startApp() {
	if (shuttingDown || currentApp !== null) return;

	const electronPath = require("electron");
	console.log(`[desktop:electron] launching ${electronPath}`);
	// The Electron npm archive cannot install chrome-sandbox as root-owned
	// setuid from an ordinary dependency install. Packaged Linux artifacts fix
	// those permissions during packaging; development must disable Chromium's
	// SUID sandbox or Electron aborts before main.cjs is evaluated.
	const platformArgs = process.platform === "linux" ? ["--no-sandbox"] : [];
	const app = spawnDevApp(
		electronPath,
		[...platformArgs, join(desktopOutDir, "main.cjs"), "--memoize-dev"],
		{
			cwd: desktopDir,

			env: {
				...process.env,
				VITE_DEV_SERVER_URL: devServerUrl,
				ZUSE_API_URL:
					process.env.ZUSE_API_URL?.trim() || deploymentProfiles.staging.apiUrl,
				VITE_ZUSE_API_URL:
					process.env.VITE_ZUSE_API_URL?.trim() ||
					deploymentProfiles.staging.apiUrl,
			},
			stdio: ["inherit", "inherit", "inherit", "ipc"],
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
		if (!shuttingDown && !expectedExits.has(app)) {
			// A rebuild goes through stopApp(), which marks the exit as expected and
			// launches the replacement itself. Any other exit includes a user closing
			// the window, so stop this watcher and let the root dev runner tear down the
			// renderer, bundle watcher, embedded server, and setup children as well.
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
		signalDevApp(app, "SIGTERM", { graceful: true });
		setTimeout(() => {
			if (settled) return;
			signalDevApp(app, "SIGKILL");
			finish();
		}, forcedShutdownTimeoutMs).unref();
	});
}

function scheduleRestart(delayMs = restartDebounceMs) {
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
	}, delayMs);
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

let watcher;

const onSignal = (code) => () => {
	watcher?.close();
	void shutdown(code);
};
process.once("SIGINT", onSignal(130));
process.once("SIGTERM", onSignal(143));
process.once("SIGHUP", onSignal(129));

process.on("message", (message) => {
	if (message?.type === "zuse:dev-shutdown") onSignal(0)();
});
if (process.send) process.once("disconnect", onSignal(0));
buildNativeHelpers();
await waitForResources();
if (!shuttingDown) {
	watcher = startWatcher();
	startApp();
}
