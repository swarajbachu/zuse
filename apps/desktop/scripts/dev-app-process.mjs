import { spawn } from "node:child_process";

export function spawnDevApp(command, args, options) {
	return spawn(command, args, {
		...options,
		detached: process.platform !== "win32",
	});
}

export function signalDevApp(app, signal, { graceful = false } = {}) {
	// A Windows tree kill would also terminate the intentionally detached engine.
	// Ask Electron to run its normal quit cleanup before falling back to a signal.
	if (graceful && signal === "SIGTERM" && app.connected) {
		app.send({ type: "zuse:dev-shutdown" }, (error) => {
			if (error && app.exitCode === null) app.kill(signal);
		});
		return;
	}

	if (process.platform !== "win32" && typeof app.pid === "number") {
		try {
			process.kill(-app.pid, signal);
			return;
		} catch (error) {
			if (error.code !== "ESRCH") throw error;
		}
	}
	app.kill(signal);
}
