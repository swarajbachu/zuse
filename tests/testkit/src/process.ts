import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

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

export type BoundedTextBuffer = {
	readonly append: (chunk: string) => void;
	readonly read: () => string;
};

export const makeBoundedTextBuffer = (limit: number): BoundedTextBuffer => {
	if (!Number.isInteger(limit) || limit <= 0) {
		throw new Error("Bounded text buffer limit must be a positive integer.");
	}
	let value = "";
	return {
		append: (chunk) => {
			value = `${value}${chunk}`.slice(-limit);
		},
		read: () => value,
	};
};

export type TestResourceScope = {
	readonly defer: (release: () => Promise<void> | void) => void;
	readonly acquire: <A>(
		acquire: () => Promise<A> | A,
		release: (resource: A) => Promise<void> | void,
	) => Promise<A>;
};

export const withResourceScope = async <A>(
	run: (resources: TestResourceScope) => Promise<A>,
): Promise<A> => {
	const releases: Array<() => Promise<void> | void> = [];
	const resources: TestResourceScope = {
		defer: (release) => releases.push(release),
		acquire: async (acquire, release) => {
			const resource = await acquire();
			releases.push(() => release(resource));
			return resource;
		},
	};
	let result: A | undefined;
	let failure: unknown;
	let failed = false;
	try {
		result = await run(resources);
	} catch (cause) {
		failed = true;
		failure = cause;
	}
	const cleanupFailures: Array<unknown> = [];
	for (const release of releases.reverse()) {
		try {
			await release();
		} catch (cause) {
			cleanupFailures.push(cause);
		}
	}
	if (failed) {
		if (cleanupFailures.length > 0) {
			throw new AggregateError(
				[failure, ...cleanupFailures],
				"Test body and resource cleanup both failed.",
			);
		}
		throw failure;
	}
	if (cleanupFailures.length > 0) {
		throw new AggregateError(cleanupFailures, "Test resource cleanup failed.");
	}
	return result as A;
};

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
		readonly env?: Readonly<Record<string, string | undefined>>;
	},
): ManagedChildProcess => {
	const child = spawn(command, [...args], {
		cwd: options.cwd,
		env: options.env as NodeJS.ProcessEnv | undefined,
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	const stdout = makeBoundedTextBuffer(OUTPUT_TAIL_LIMIT);
	const stderr = makeBoundedTextBuffer(OUTPUT_TAIL_LIMIT);
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
		stdout.append(text);
		const pending = `${stdoutRemainder}${text}`.split(/\r?\n/);
		stdoutRemainder = pending.pop() ?? "";
		for (const line of pending) acceptLine(line);
	};
	child.stdout.on("data", accept);
	child.stderr.on("data", (chunk) => {
		stderr.append(String(chunk));
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
						`Timed out waiting for ${description}.\nstdout:\n${stdout.read()}\nstderr:\n${stderr.read()}`,
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
						`Timed out waiting for child process exit.\nstdout:\n${stdout.read()}\nstderr:\n${stderr.read()}`,
					),
				);
			}, timeoutMs);
			child.once("exit", onExit);
		});

	return {
		child,
		output: () => ({ stdout: stdout.read(), stderr: stderr.read() }),
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

export const waitForFile = (
	path: string,
	timeoutMs = 10_000,
	signal?: AbortSignal,
): Promise<void> => {
	if (existsSync(path)) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const expectedName = basename(path);
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let watcher: ReturnType<typeof watch> | undefined;
		const onAbort = (): void =>
			finish(new Error(`Stopped waiting for file ${path}`));
		const finish = (cause?: Error): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			watcher?.close();
			signal?.removeEventListener("abort", onAbort);
			if (cause === undefined) resolve();
			else reject(cause);
		};
		if (signal?.aborted === true) {
			finish(new Error(`Stopped waiting for file ${path}`));
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		watcher = watch(dirname(path), (_event, filename) => {
			if (
				(filename === null || String(filename) === expectedName) &&
				existsSync(path)
			) {
				finish();
			}
		});
		watcher.once("error", (cause) => finish(cause));
		timer = setTimeout(
			() => finish(new Error(`Timed out waiting for file ${path}`)),
			timeoutMs,
		);
		if (existsSync(path)) finish();
	});
};
