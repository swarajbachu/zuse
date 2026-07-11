import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ProcessOutput = {
	readonly stdout: string;
	readonly stderr: string;
};

export type ManagedChildProcess = {
	readonly child: ChildProcessWithoutNullStreams;
	readonly output: () => ProcessOutput;
	readonly waitForStdout: (
		predicate: (line: string) => boolean,
		description: string,
		timeoutMs?: number,
	) => Promise<string>;
	readonly waitForExit: (timeoutMs?: number) => Promise<number | null>;
	readonly stop: (signal?: NodeJS.Signals) => Promise<void>;
};

const OUTPUT_TAIL_LIMIT = 64 * 1024;
const LINE_HISTORY_LIMIT = 512;

const appendTail = (current: string, chunk: string): string =>
	`${current}${chunk}`.slice(-OUTPUT_TAIL_LIMIT);

export const makeHermeticEnvironment = (
	overrides: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
	const environment: Record<string, string> = {};
	for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ"]) {
		const value = process.env[key];
		if (value !== undefined) environment[key] = value;
	}
	for (const [key, value] of Object.entries(overrides)) {
		if (value !== undefined) environment[key] = value;
	}
	return environment;
};

export const spawnManaged = (
	command: string,
	args: ReadonlyArray<string>,
	options: {
		readonly cwd: string;
		readonly env?: NodeJS.ProcessEnv;
	},
): ManagedChildProcess => {
	const child = spawn(command, [...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	let stdout = "";
	let stderr = "";
	let stdoutRemainder = "";
	const stdoutLines: Array<string> = [];
	const waiters = new Set<{
		readonly predicate: (line: string) => boolean;
		resolve: (line: string) => void;
	}>();

	const acceptLine = (line: string): void => {
		stdoutLines.push(line);
		if (stdoutLines.length > LINE_HISTORY_LIMIT) stdoutLines.shift();
		for (const waiter of waiters) {
			if (!waiter.predicate(line)) continue;
			waiters.delete(waiter);
			waiter.resolve(line);
		}
	};
	const accept = (chunk: Buffer | string): void => {
		const text = String(chunk);
		stdout = appendTail(stdout, text);
		const pending = `${stdoutRemainder}${text}`.split(/\r?\n/);
		stdoutRemainder = pending.pop() ?? "";
		for (const line of pending) acceptLine(line);
	};
	child.stdout.on("data", accept);
	child.stderr.on("data", (chunk) => {
		stderr = appendTail(stderr, String(chunk));
	});
	child.stdout.once("end", () => {
		if (stdoutRemainder.length > 0) {
			acceptLine(stdoutRemainder);
			stdoutRemainder = "";
		}
	});

	const waitForStdout: ManagedChildProcess["waitForStdout"] = (
		predicate,
		description,
		timeoutMs = 10_000,
	) => {
		const existing = stdoutLines.find(predicate);
		if (existing !== undefined) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const waiter: {
				readonly predicate: (line: string) => boolean;
				resolve: (line: string) => void;
			} = { predicate, resolve: (line) => resolve(line) };
			waiters.add(waiter);
			const timer = setTimeout(() => {
				waiters.delete(waiter);
				reject(
					new Error(
						`Timed out waiting for ${description}.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
					),
				);
			}, timeoutMs);
			waiter.resolve = (line: string) => {
				clearTimeout(timer);
				resolve(line);
			};
		});
	};

	const stop: ManagedChildProcess["stop"] = async (signal = "SIGTERM") => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise<void>((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) resolve();
			else child.once("exit", () => resolve());
		});
		try {
			if (process.platform === "win32" || child.pid === undefined) {
				child.kill(signal);
			} else {
				process.kill(-child.pid, signal);
			}
		} catch {
			child.kill(signal);
		}
		const timer = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) {
				try {
					if (process.platform === "win32" || child.pid === undefined) {
						child.kill("SIGKILL");
					} else {
						process.kill(-child.pid, "SIGKILL");
					}
				} catch {
					child.kill("SIGKILL");
				}
			}
		}, 2_000);
		await exited;
		clearTimeout(timer);
	};

	const waitForExit: ManagedChildProcess["waitForExit"] = (
		timeoutMs = 10_000,
	) =>
		new Promise((resolve, reject) => {
			if (child.exitCode !== null || child.signalCode !== null) {
				resolve(child.exitCode);
				return;
			}
			const onExit = (code: number | null): void => {
				clearTimeout(timer);
				resolve(code);
			};
			const timer = setTimeout(() => {
				child.off("exit", onExit);
				reject(
					new Error(
						`Timed out waiting for child process exit.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
					),
				);
			}, timeoutMs);
			child.once("exit", onExit);
		});

	return {
		child,
		output: () => ({ stdout, stderr }),
		waitForStdout,
		waitForExit,
		stop,
	};
};

export const makeTemporaryDirectory = (
	prefix: string,
): {
	readonly path: string;
	readonly dispose: () => void;
} => {
	const path = mkdtempSync(join(tmpdir(), prefix));
	return {
		path,
		dispose: () => rmSync(path, { recursive: true, force: true }),
	};
};

export const eventually = async <A>(
	read: () => Promise<A> | A,
	accept: (value: A) => boolean,
	description: string,
	timeoutMs = 10_000,
): Promise<A> => {
	const deadline = Date.now() + timeoutMs;
	let last: A | undefined;
	while (Date.now() < deadline) {
		last = await read();
		if (accept(last)) return last;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(
		`Timed out waiting for ${description}. Last value: ${JSON.stringify(last)}`,
	);
};
