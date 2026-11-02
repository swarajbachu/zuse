import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stopOwnedProcess } from "@zuse/utils/owned-process";
import { createLinuxLocalConnectivity } from "./linux-local-connectivity.ts";

export const createLocalConnectivity = (options: {
	readonly helperPath?: string;
	readonly serviceName: string;
	readonly log: (event: string, fields?: Record<string, unknown>) => void;
}) => {
	if (process.platform === "linux")
		return createLinuxLocalConnectivity(options);
	let child: ChildProcessWithoutNullStreams | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	let failures = 0;
	let target: { port: number; pin?: string } | null = null;
	const launch = () => {
		if (stopped || child !== null || target === null) return;
		if (process.platform !== "darwin") return;
		if (
			process.platform === "darwin" &&
			(!options.helperPath || !existsSync(options.helperPath))
		) {
			options.log("local.helper.unavailable");
			return;
		}
		const { port, pin } = target;
		const command = options.helperPath;
		if (command === undefined) return;
		const args = [
			String(port),
			options.serviceName,
			...(pin === undefined ? [] : [pin]),
		];
		const startedAt = performance.now();
		const owned = spawn(command, args, {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		});
		child = owned;
		owned.stdout.setEncoding("utf8");
		owned.stderr.setEncoding("utf8");
		owned.stdout.on("data", (chunk: string) =>
			options.log("local.helper.event", { message: chunk.trim() }),
		);
		owned.stderr.on("data", (chunk: string) =>
			options.log("local.helper.stderr", { message: chunk.trim() }),
		);
		owned.once("error", () => options.log("local.helper.spawn_failed"));
		owned.once("close", (code, signal) => {
			if (child === owned) child = null;
			options.log("local.helper.exit", { code, signal });
			if (stopped) return;
			failures = performance.now() - startedAt >= 30_000 ? 1 : failures + 1;
			timer = setTimeout(launch, Math.min(16_000, 1_000 * 2 ** (failures - 1)));
			timer.unref();
		});
	};
	let closing: Promise<void> | undefined;
	return {
		start: (port: number, pin?: string): void => {
			if (stopped || target !== null) return;
			target = { port, pin };
			launch();
		},
		close: (): Promise<void> => {
			if (closing !== undefined) return closing;
			stopped = true;
			clearTimeout(timer);
			const owned = child;
			child = null;
			owned?.stdin.end();
			closing =
				owned === null
					? Promise.resolve()
					: stopOwnedProcess(owned, { graceMs: 5_000 });
			return closing;
		},
	};
};
