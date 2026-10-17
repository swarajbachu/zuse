import type { ChildProcess } from "node:child_process";
import {
	SUPERVISED_COMMAND_LEASE_MS,
	signalProcessGroup,
	spawnSupervisedProcess,
} from "../process/process-group.ts";

/** The existing lease supervisor kills native helpers if the owning server disappears. */
export function startHelper(
	file: string,
	args: readonly string[],
	cwd: string,
	signal: AbortSignal,
	onExit?: () => void,
	env?: NodeJS.ProcessEnv,
) {
	const child = spawnSupervisedProcess(
		file,
		args,
		cwd,
		Date.now() + SUPERVISED_COMMAND_LEASE_MS,
		{ killDescendantsOnExit: true, ...(env ? { env } : {}) },
	);
	child.stdin?.on("error", () => {});
	const lease = setInterval(
		() => child.stdin?.write(`${Date.now() + SUPERVISED_COMMAND_LEASE_MS}\n`),
		3000,
	);
	lease.unref();
	const stop = () => signalProcessGroup(child, "SIGKILL");
	signal.addEventListener("abort", stop, { once: true });
	const cleanup = () => {
		clearInterval(lease);
		signal.removeEventListener("abort", stop);
		onExit?.();
	};
	child.once("exit", cleanup);
	child.once("error", cleanup);
	if (signal.aborted) stop();
	return child;
}

export function runHelper(
	file: string,
	args: readonly string[],
	cwd: string,
	signal: AbortSignal,
	timeoutMs = 30000,
	env?: NodeJS.ProcessEnv,
	onOutput?: (chunk: string) => void,
): Promise<string> {
	const controller = new AbortController();
	const combined = AbortSignal.any([signal, controller.signal]);
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	return new Promise<string>((resolve, reject) => {
		const child = startHelper(file, args, cwd, combined, undefined, env);
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			onOutput?.(chunk.toString());
			if (output.length > 2 * 1024 * 1024) {
				controller.abort();
				reject(new Error("Device command output exceeded its limit"));
			}
		});
		child.stderr?.resume();
		child.once("error", reject);
		child.once("close", (code) =>
			code === 0 && !combined.aborted
				? resolve(output)
				: reject(
						new Error(
							combined.aborted
								? "Device command cancelled or timed out"
								: `Device command failed (${code}): ${file}`,
						),
					),
		);
	}).finally(() => clearTimeout(timeout));
}

export function discardOutput(child: ChildProcess) {
	child.stdout?.resume();
	child.stderr?.resume();
}
