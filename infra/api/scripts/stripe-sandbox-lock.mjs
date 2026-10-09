import { chmodSync, closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";

/** Acquires an exclusive runner lock and releases it on exit or termination. */
export function acquireRunnerLock(directory) {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const path = `${directory}/runner.lock`;
	const descriptor = openSync(path, "wx", 0o600);
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		process.removeListener("exit", release);
		process.removeListener("SIGINT", interrupt);
		process.removeListener("SIGTERM", terminate);
		try {
			closeSync(descriptor);
		} finally {
			unlinkSync(path);
		}
	};
	const interrupt = () => {
		release();
		process.exit(130);
	};
	const terminate = () => {
		release();
		process.exit(143);
	};
	process.on("exit", release);
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", terminate);
	return release;
}
