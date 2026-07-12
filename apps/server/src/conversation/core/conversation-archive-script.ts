/** Executes the configured chat archive cleanup script. */
import { spawn } from "node:child_process";
import {
	ChatArchiveScriptError,
	ChatArchiveTimeoutError,
	type ChatId,
} from "@zuse/contracts";
import { Effect } from "effect";

const TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_LIMIT = 12_000;

const truncateOutput = (value: string): string =>
	value.length <= OUTPUT_LIMIT
		? value
		: `…${value.slice(value.length - OUTPUT_LIMIT)}`;

export interface RunArchiveScriptOptions {
	readonly chatId: ChatId;
	readonly script: string;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
}

export const runArchiveScript = (
	options: RunArchiveScriptOptions,
): Effect.Effect<
	{ readonly output: string },
	ChatArchiveScriptError | ChatArchiveTimeoutError
> =>
	Effect.tryPromise({
		try: () =>
			new Promise<{ readonly output: string }>((resolve, reject) => {
				let output = "";
				let timedOut = false;
				const child = spawn("/bin/zsh", ["-lc", options.script], {
					cwd: options.cwd,
					env: {
						...(process.env as Record<string, string>),
						...options.env,
					},
					stdio: ["ignore", "pipe", "pipe"],
				});

				const append = (chunk: unknown) => {
					output = truncateOutput(output + String(chunk));
				};
				child.stdout?.on("data", append);
				child.stderr?.on("data", append);

				const timer = setTimeout(() => {
					timedOut = true;
					try {
						child.kill("SIGKILL");
					} catch {
						// The child may have exited between the timer firing and kill.
					}
				}, TIMEOUT_MS);

				child.on("error", (error) => {
					clearTimeout(timer);
					reject(
						new ChatArchiveScriptError({
							chatId: options.chatId,
							exitCode: null,
							signal: null,
							output: truncateOutput(output || error.message),
						}),
					);
				});
				child.on("close", (code, signal) => {
					clearTimeout(timer);
					const finalOutput = truncateOutput(output);
					if (timedOut) {
						reject(
							new ChatArchiveTimeoutError({
								chatId: options.chatId,
								timeoutMs: TIMEOUT_MS,
								output: finalOutput,
							}),
						);
					} else if (code !== 0) {
						reject(
							new ChatArchiveScriptError({
								chatId: options.chatId,
								exitCode: code,
								signal,
								output: finalOutput,
							}),
						);
					} else {
						resolve({ output: finalOutput });
					}
				});
			}),
		catch: (error) =>
			error instanceof ChatArchiveScriptError ||
			error instanceof ChatArchiveTimeoutError
				? error
				: new ChatArchiveScriptError({
						chatId: options.chatId,
						exitCode: null,
						signal: null,
						output: error instanceof Error ? error.message : String(error),
					}),
	});
