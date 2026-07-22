import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	devInstanceDiagnostics,
	initialDevInstance,
	reserveDevPortPair,
	withScannedPorts,
} from "./dev-instance.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const rendererHost = process.env.HOST?.trim() || "localhost";

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
			);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

const diagnostics = devInstanceDiagnostics(instance, rendererHost);
console.log(`[dev] ${JSON.stringify(diagnostics, null, 2)}`);
if (instance.dryRun) process.exit(0);

const children = [];
let shuttingDown = false;

function run(name, command, args, extraEnv = {}) {
	const child = spawn(command, args, {
		cwd: repoRoot,
		stdio: "inherit",
		env: { ...process.env, ...extraEnv, FORCE_COLOR: "1" },
	});
	child.once("exit", (code, signal) => {
		if (shuttingDown) return;
		console.error(
			`[${name}] exited (code=${code ?? "null"} signal=${signal ?? "null"})`,
		);
		void shutdown(code ?? 1);
	});
	children.push({ name, child });
}

async function shutdown(code) {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const { child } of children) {
		if (child.exitCode === null) child.kill("SIGTERM");
	}
	instance.releaseReservation?.();
	setTimeout(() => process.exit(code), 500).unref();
}

const sharedEnv = {
	ZUSE_DEV_INSTANCE: instance.instance,
	ZUSE_DESKTOP_WS_PORT: String(instance.websocketPort),
	ZUSE_USER_DATA_DIR: instance.userDataDir,
	ZUSE_DESKTOP_OUT_DIR: instance.packDir,
	ZUSE_DESKTOP_DIR: resolve(repoRoot, "apps", "desktop"),
	ZUSE_RENDERER_DIST_DIR: resolve(repoRoot, "apps", "renderer", "dist"),
};
run("renderer", "bun", ["run", "--filter", "renderer", "dev"], {
	...sharedEnv,
	PORT: String(instance.rendererPort),
	HOST: rendererHost,
});
run(
	"desktop:bundle",
	"bun",
	["run", "--filter", "desktop", "dev:bundle"],
	sharedEnv,
);
run("desktop:electron", "bun", ["run", "--filter", "desktop", "dev:electron"], {
	...sharedEnv,
	VITE_DEV_SERVER_URL: diagnostics.rendererUrl,
});

process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));
process.once("SIGHUP", () => void shutdown(129));
