/** Executes the configured chat archive cleanup script. */
import { spawn } from "node:child_process";
import {
	ChatArchiveScriptError,
	ChatArchiveTimeoutError,
	type ChatId,
} from "@zuse/contracts";
import { scriptCommandForPlatform } from "@zuse/utils/shell-command";
import { Effect } from "effect";
import { signalProcessGroup } from "../../process/process-group.ts";

const TIMEOUT_MS = 10 * 60 * 1000;
const INTERRUPT_GRACE_MS = 1_000;
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
	Effect.callback<
		{ readonly output: string },
		ChatArchiveScriptError | ChatArchiveTimeoutError
	>((resume) => {
		let output = "";
		let timedOut = false;
		let settled = false;
		const shell = scriptCommandForPlatform(
			process.platform,
			options.script,
			process.env,
		);
		const child = spawn(shell.command, [...shell.args], {
			cwd: options.cwd,
			detached: process.platform !== "win32",
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
			signalProcessGroup(child, "SIGKILL");
		}, TIMEOUT_MS);

		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resume(
				Effect.fail(
					new ChatArchiveScriptError({
						chatId: options.chatId,
						exitCode: null,
						signal: null,
						output: truncateOutput(output || error.message),
					}),
				),
			);
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const finalOutput = truncateOutput(output);
			if (timedOut) {
				resume(
					Effect.fail(
						new ChatArchiveTimeoutError({
							chatId: options.chatId,
							timeoutMs: TIMEOUT_MS,
							output: finalOutput,
						}),
					),
				);
			} else if (code !== 0) {
				resume(
					Effect.fail(
						new ChatArchiveScriptError({
							chatId: options.chatId,
							exitCode: code,
							signal,
							output: finalOutput,
						}),
					),
				);
			} else {
				resume(Effect.succeed({ output: finalOutput }));
			}
		});
		return Effect.callback<void>((completeInterruption) => {
			if (settled) {
				completeInterruption(Effect.void);
				return;
			}
			settled = true;
			clearTimeout(timer);
			let interruptionComplete = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			let finalTimer: ReturnType<typeof setTimeout> | undefined;
			const finish = () => {
				if (interruptionComplete) return;
				interruptionComplete = true;
				if (killTimer !== undefined) clearTimeout(killTimer);
				if (finalTimer !== undefined) clearTimeout(finalTimer);
				completeInterruption(Effect.void);
			};
			child.once("close", finish);
			const signalGroup = (signal: NodeJS.Signals) => {
				signalProcessGroup(child, signal);
			};
			signalGroup("SIGTERM");
			killTimer = setTimeout(() => signalGroup("SIGKILL"), INTERRUPT_GRACE_MS);
			finalTimer = setTimeout(finish, INTERRUPT_GRACE_MS * 2);
			return Effect.sync(() => {
				clearTimeout(killTimer);
				clearTimeout(finalTimer);
				child.off("close", finish);
			});
		});
	});
