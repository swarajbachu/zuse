import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	connectLocalEngine,
	readEngineEndpoint,
} from "../apps/server/src/desktop-engine/index.ts";
import deploymentProfiles from "../packages/contracts/src/deployment-profiles.json" with {
	type: "json",
};
import { stopOwnedProcess } from "../packages/utils/src/owned-process.ts";
import { resolveZuseDesktopUserData } from "../packages/utils/src/zuse-user-data.ts";

import {
	devInstanceDiagnostics,
	initialDevInstance,
	reserveDevPortPair,
	withScannedPorts,
} from "./dev-instance.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const managedChildPath = resolve(scriptDir, "dev-child.mjs");
const rendererHost = process.env.HOST?.trim() || "localhost";
const defaultUserData = resolveZuseDesktopUserData({
	platform: process.platform,
	homeDir: homedir(),
	env: process.env,
	development: true,
});

const portAvailable = (port, kind) =>
	new Promise((resolveAvailable) => {
		const server = createServer();
		const finish = (available) => {
			server.removeAllListeners();
			resolveAvailable(available);
		};
		server.once("error", () => finish(false));
		server.once("listening", () => server.close(() => finish(true)));
		server.listen(port, kind === "renderer" ? rendererHost : "127.0.0.1");
	});

const reusableDefaultEngine = async (initial, port, kind) => {
	if (kind !== "websocket" || !initial.defaultProfile) return false;
	try {
		const endpoint = await readEngineEndpoint(defaultUserData);
		if (endpoint === null || endpoint.apiPort !== port) return false;
		const channel = await connectLocalEngine(endpoint, {
			receive: () => {},
			signal: AbortSignal.timeout(2_000),
		});
		channel.close();
		await channel.closed;
		return true;
	} catch {
		return false;
	}
};

let instance;
try {
	const initial = initialDevInstance({
		argv: process.argv.slice(2),
		env: process.env,
		repoRoot,
	});
	instance = initial.dryRun
		? initial
		: await withScannedPorts(
				initial,
				portAvailable,
				(rendererPort, websocketPort) =>
					reserveDevPortPair(repoRoot, rendererPort, websocketPort),
				(port, kind) => reusableDefaultEngine(initial, port, kind),
			);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

const diagnostics = devInstanceDiagnostics(instance, rendererHost);
console.log(`[dev] ${JSON.stringify(diagnostics, null, 2)}`);
if (instance.dryRun) process.exit(0);

const devStartedAt = Date.now();

const children = [];
let shuttingDown = false;

function run(
	name,
	command,
	args,
	extraEnv = {},
	cooperative = false,
	isolated = false,
) {
	const child = spawn(command, args, {
		cwd: repoRoot,
		stdio: cooperative
			? [isolated ? "ignore" : "inherit", "inherit", "inherit", "ipc"]
			: ["ignore", "inherit", "inherit"],
		// Isolate non-cooperative watchers from Ctrl+C on Windows as well. This lets
		// shutdown own their still-live wrapper PID and retire the complete tree;
		// ignoring stdin also keeps the PTY's Ctrl+C byte from reaching them first.
		detached: isolated || !cooperative,
		windowsHide: true,
		env: { ...process.env, ...extraEnv, FORCE_COLOR: "1" },
	});
	child.once("error", (error) => {
		console.error(`[${name}] failed to start ${command}: ${error.message}`);
		void shutdown(1);
	});
	child.once("exit", (code, signal) => {
		if (shuttingDown) return;
		console.error(
			`[${name}] exited (code=${code ?? "null"} signal=${signal ?? "null"})`,
		);
		void shutdown(code ?? 1);
	});
	children.push({ name, child, cooperative });
}

function runManaged(name, command, args, extraEnv = {}) {
	run(
		name,
		process.execPath,
		[managedChildPath, command, ...args],
		extraEnv,
		true,
		true,
	);
}

async function shutdown(code) {
	if (shuttingDown) return;
	shuttingDown = true;
	const results = await Promise.allSettled(
		children.map(async ({ child, cooperative }) => {
			if (!cooperative) return stopOwnedProcess(child, { processGroup: true });
			if (
				child.exitCode !== null ||
				child.signalCode !== null ||
				child.pid === undefined
			)
				return;
			await new Promise((resolveStop) => {
				const timer = setTimeout(() => {
					child.kill("SIGKILL");
					resolveStop();
				}, 8_000);
				child.once("exit", () => {
					clearTimeout(timer);
					resolveStop();
				});
				if (child.connected)
					child.send({ type: "zuse:dev-shutdown" }, () => {});
				else child.kill("SIGTERM");
			});
		}),
	);
	for (const result of results)
		if (result.status === "rejected") {
			console.error("[dev] cleanup failed:", result.reason);
			code = 1;
		}
	instance.releaseReservation?.();
	process.exit(code);
}

const sharedEnv = {
	WORKOS_CLIENT_ID:
		process.env.WORKOS_CLIENT_ID?.trim() ||
		deploymentProfiles.staging.workosPublicClientId,
	VITE_WORKOS_CLIENT_ID:
		process.env.VITE_WORKOS_CLIENT_ID?.trim() ||
		deploymentProfiles.staging.workosPublicClientId,
	ZUSE_API_URL:
		process.env.ZUSE_API_URL?.trim() || deploymentProfiles.staging.apiUrl,
	VITE_ZUSE_API_URL:
		process.env.VITE_ZUSE_API_URL?.trim() || deploymentProfiles.staging.apiUrl,
	ZUSE_DEV_INSTANCE: instance.instance,
	ZUSE_DEV_STARTED_AT: String(devStartedAt),
	ZUSE_DESKTOP_WS_PORT: String(instance.websocketPort),
	ZUSE_DEV_CLI_ACCESS_FILE: instance.cliAccessFile,
	...(instance.userDataDir ? { ZUSE_USER_DATA_DIR: instance.userDataDir } : {}),
	ZUSE_DESKTOP_OUT_DIR: instance.packDir,
	ZUSE_DESKTOP_DIR: resolve(repoRoot, "apps", "desktop"),
	ZUSE_RENDERER_DIST_DIR: resolve(repoRoot, "apps", "renderer", "dist"),
};
runManaged("renderer", "bun", ["run", "--filter", "renderer", "dev"], {
	...sharedEnv,
	PORT: String(instance.rendererPort),
	HOST: rendererHost,
	ZUSE_VITE_CACHE_DIR: instance.viteCacheDir,
});
runManaged(
	"desktop:bundle",
	"bun",
	["run", "--filter", "desktop", "dev:bundle"],
	sharedEnv,
);
run(
	"desktop:electron",
	process.execPath,
	[resolve(repoRoot, "apps/desktop/scripts/dev-electron.mjs")],
	{
		...sharedEnv,
		VITE_DEV_SERVER_URL: diagnostics.rendererUrl,
	},
	true,
);

process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));
process.once("SIGHUP", () => void shutdown(129));

process.on("message", (message) => {
	if (message?.type === "zuse:dev-shutdown") void shutdown(0);
});
if (process.send) process.once("disconnect", () => void shutdown(0));
