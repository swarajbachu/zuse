import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { signalDevApp, spawnDevApp } from "./dev-app-process.mjs";

const fixture = `
const { spawn } = require('node:child_process');
const { once } = require('node:events');
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100));
(async () => {
  const children = await Promise.all([false, true].map(async detached => {
    const child = spawn(process.execPath, ['-e', \`
      const server = require('node:net').createServer(s => s.end());
      server.listen(0, '127.0.0.1', () => process.send({port: server.address().port}));
      process.on('disconnect', () => {});
    \`], { detached, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const [ready] = await once(child, 'message');
    return { pid: child.pid, ...ready };
  }));
  process.send(children);
  setInterval(() => {}, 1000);
})();
`;

function reachable(port) {
	return new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		const finish = (connected) => {
			socket.destroy();
			resolve(connected);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		socket.setTimeout(500, () => finish(false));
	});
}

for (const signal of ["SIGTERM", "SIGKILL"]) {
	test(`dev ${signal} cleans up shell helpers and preserves detached engine`, {
		skip: process.platform === "win32",
		timeout: 5_000,
	}, async () => {
		const app = spawnDevApp(process.execPath, ["-e", fixture], {
			stdio: ["ignore", "ignore", "inherit", "ipc"],
		});
		let children = [];
		try {
			[children] = await once(app, "message");
			const [helper, engine] = children;
			assert.equal(await reachable(helper.port), true);
			assert.equal(await reachable(engine.port), true);
			const exited = once(app, "exit");
			signalDevApp(app, signal);
			await exited;
			for (let i = 0; i < 50 && (await reachable(helper.port)); i++) {
				await delay(10);
			}
			assert.equal(
				await reachable(helper.port),
				false,
				"shell helper must stop",
			);
			assert.equal(
				await reachable(engine.port),
				true,
				"engine must survive shell restart",
			);
		} finally {
			for (const child of [app, ...children]) {
				try {
					process.kill(child.pid, "SIGKILL");
				} catch {}
			}
		}
	});
}

test("cooperative shutdown reaches the application on Windows and POSIX", {
	timeout: 5_000,
}, async () => {
	const app = spawnDevApp(
		process.execPath,
		[
			"-e",
			`
 process.on('message', message => {
  if (message.type === 'zuse:dev-shutdown') {
   process.send('cleaned-up', () => process.exit(0));
  }
 });
 process.send('ready');
 `,
		],
		{ stdio: ["ignore", "ignore", "inherit", "ipc"] },
	);
	try {
		await once(app, "message");
		const message = once(app, "message");
		const exited = once(app, "exit");
		signalDevApp(app, "SIGTERM", { graceful: true });
		assert.deepEqual(await message, ["cleaned-up", undefined]);
		assert.deepEqual(await exited, [0, null]);
	} finally {
		if (app.exitCode === null) app.kill("SIGKILL");
	}
});

test("launcher can shut down while waiting for build artifacts", {
	timeout: 10_000,
	skip: process.platform === "darwin",
}, async () => {
	const { fork } = await import("node:child_process");
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const root = await mkdtemp(join(tmpdir(), "zuse waiting-"));
	const launcher = fork(new URL("./dev-electron.mjs", import.meta.url), [], {
		stdio: ["ignore", "pipe", "inherit", "ipc"],
		env: {
			...process.env,
			ZUSE_DESKTOP_OUT_DIR: root,
			VITE_DEV_SERVER_URL: "http://127.0.0.1:1",
		},
	});
	try {
		await new Promise((resolve) =>
			launcher.stdout.on("data", (chunk) => {
				if (String(chunk).includes("waiting for")) resolve();
			}),
		);
		const exited = once(launcher, "exit");
		launcher.send({ type: "zuse:dev-shutdown" });
		assert.deepEqual(await exited, [0, null]);
	} finally {
		if (launcher.exitCode === null) launcher.kill("SIGKILL");
		await rm(root, { recursive: true, force: true });
	}
});

test("launcher reports the exact resources that blocked startup", {
	timeout: 10_000,
	skip: process.platform === "darwin",
}, async () => {
	const { fork } = await import("node:child_process");
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const root = await mkdtemp(join(tmpdir(), "zuse timeout-"));
	const launcher = fork(new URL("./dev-electron.mjs", import.meta.url), [], {
		stdio: ["ignore", "ignore", "pipe", "ipc"],
		env: {
			...process.env,
			ZUSE_DESKTOP_OUT_DIR: root,
			ZUSE_DEV_STARTUP_TIMEOUT_MS: "250",
			VITE_DEV_SERVER_URL: "http://127.0.0.1:1",
		},
	});
	let stderr = "";
	launcher.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	try {
		const [code] = await once(launcher, "exit");
		assert.notEqual(code, 0);
		assert.match(
			stderr,
			/renderer http:\/\/127\.0\.0\.1:1 is not accepting connections/,
		);
		assert.match(stderr, /artifact is missing: .*main\.cjs/);
		assert.match(stderr, /artifact is missing: .*preload\.cjs/);
	} finally {
		if (launcher.exitCode === null) launcher.kill("SIGKILL");
		await rm(root, { recursive: true, force: true });
	}
});
