import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	readDesktopEngineConfig,
	superviseEngine,
} from "@zusehq/server/desktop-engine/supervisor";
import {
	appendRotatingLogFile,
	makeBatchedLogWriter,
} from "./batched-log-writer.ts";
import { verifyEngineBuild } from "./engine-build-id.ts";
import { runOwnedHelper } from "./owned-helper.ts";

const main = async () => {
	if (process.argv[2] === "--owned-helper") {
		const command = process.argv[3];
		if (command === undefined)
			throw new Error("Missing native helper command.");
		process.exitCode = await runOwnedHelper(command, process.argv.slice(4));
		return;
	}
	const path = process.argv[2],
		entry = process.argv[1];
	if (path === undefined || entry === undefined)
		throw new Error("Missing engine supervisor configuration.");
	const config = await readDesktopEngineConfig(path);
	await verifyEngineBuild(config.buildId, entry);
	const logPath = join(config.userData, "engine", "runtime.log");
	const writer = makeBatchedLogWriter({
		writeBatch: async (file, lines) => {
			await mkdir(dirname(file), { recursive: true, mode: 0o700 });
			await appendRotatingLogFile(file, lines.join(""), { mode: 0o600 });
		},
	});
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	try {
		await superviseEngine({
			userData: config.userData,
			signal: controller.signal,
			spawnWorker: () =>
				spawn(
					process.execPath,
					[join(dirname(entry), "engine-main.cjs"), path],
					{
						env: process.env,
						stdio: ["ignore", "pipe", "pipe", "ipc"],
						windowsHide: true,
					},
				),
			log: (message) => writer.append(logPath, message),
		});
	} finally {
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
		await writer.flush();
	}
};
void main().catch((error) => {
	console.error(
		error instanceof Error ? error.message : "Engine supervisor failed.",
	);
	process.exitCode = 1;
});
