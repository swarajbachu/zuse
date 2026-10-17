import type { ChildProcess } from "node:child_process";
import type {
	SpawnedProcess,
	SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "@zuse/utils/spawn-command";
import {
	stopProviderProcess,
	watchProviderProcess,
} from "../kernel/provider-process.ts";

/** Keep SDK subprocess ownership until its tools have been stopped. */
export const makeClaudeProcessOwner = () => {
	const children = new Set<ChildProcess>();
	let closed = false;
	let closing: Promise<void> | undefined;
	const stop = (child: ChildProcess) =>
		stopProviderProcess(child, { processGroup: true });
	return {
		spawn: (options: SpawnOptions): SpawnedProcess => {
			if (closed) throw new Error("Claude subprocess owner is closed");
			options.signal.throwIfAborted();
			const child = spawn(options.command, options.args, {
				cwd: options.cwd,
				env: options.env,
				detached: process.platform !== "win32",
				windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
			});
			children.add(child);
			watchProviderProcess(child);
			// The SDK's custom-spawn contract does not consume stderr. Drain it
			// without logging provider output that can contain credentials.
			child.stderr.resume();
			const abort = () => {
				void stop(child).catch(() => {});
			};
			options.signal.addEventListener("abort", abort, { once: true });
			child.once("close", () => {
				options.signal.removeEventListener("abort", abort);

				void stop(child).then(
					() => children.delete(child),
					() => {},
				);
			});
			return child;
		},
		close: (): Promise<void> => {
			closed = true;
			if (closing !== undefined) return closing;
			const attempt = Promise.all([...children].map(stop)).then(
				() => undefined,
			);
			closing = attempt;
			void attempt.catch(() => {
				if (closing === attempt) closing = undefined;
			});
			return attempt;
		},
	};
};
