import { spawn } from "node:child_process";
import { stopOwnedProcess } from "../packages/utils/src/owned-process.ts";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("Missing managed development command.");

const child = spawn(command, args, {
	cwd: process.cwd(),
	stdio: ["ignore", "inherit", "inherit"],
	detached: true,
	windowsHide: true,
	env: process.env,
});

let shuttingDown = false;
const shutdown = async (code) => {
	if (shuttingDown) return;
	shuttingDown = true;
	try {
		await stopOwnedProcess(child, { processGroup: true });
	} catch (error) {
		console.error(
			"[dev:child] cleanup failed:",
			error instanceof Error ? error.message : String(error),
		);
		code = 1;
	}
	process.exit(code);
};

child.once("error", (error) => {
	console.error(`[dev:child] failed to start ${command}: ${error.message}`);
	void shutdown(1);
});
child.once("exit", (code, signal) => {
	if (shuttingDown) return;
	if (signal !== null)
		console.error(`[dev:child] ${command} exited from signal ${signal}`);
	void shutdown(code ?? 1);
});

process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));
process.once("SIGHUP", () => void shutdown(129));
process.on("message", (message) => {
	if (message?.type === "zuse:dev-shutdown") void shutdown(0);
});
if (process.send) process.once("disconnect", () => void shutdown(0));
