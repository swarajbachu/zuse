import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireRunnerLock } from "./stripe-sandbox-lock.mjs";

test("creates a fresh private directory and does not remove a contender's lock", () => {
	const root = mkdtempSync(join(tmpdir(), "stripe-lock-"));
	const directory = join(root, "fresh");
	try {
		const release = acquireRunnerLock(directory);
		try {
			assert.equal(statSync(directory).mode & 0o777, 0o700);
			assert.equal(statSync(`${directory}/runner.lock`).mode & 0o777, 0o600);
			assert.throws(() => acquireRunnerLock(directory), { code: "EEXIST" });
			assert(existsSync(`${directory}/runner.lock`));
		} finally {
			release();
			release();
		}
		assert(!existsSync(`${directory}/runner.lock`));
		acquireRunnerLock(directory)();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
for (const signal of [undefined, "SIGINT", "SIGTERM"]) {
	test(`releases lock on ${signal ?? "normal exit"}`, async () => {
		const directory = mkdtempSync(join(tmpdir(), "stripe-lock-"));
		const module = new URL("./stripe-sandbox-lock.mjs", import.meta.url).href;
		const script = `import {acquireRunnerLock} from ${JSON.stringify(module)}; acquireRunnerLock(${JSON.stringify(directory)}); console.log('ready'); ${signal ? "setInterval(() => {}, 1000)" : ""}`;
		const child = spawn(process.execPath, [
			"--input-type=module",
			"-e",
			script,
		]);
		const exited = once(child, "exit");
		try {
			await once(child.stdout, "data");
			if (signal) child.kill(signal);
			const [code] = await exited;
			assert.equal(
				code,
				signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 0,
			);
			assert(!existsSync(`${directory}/runner.lock`));
			acquireRunnerLock(directory)();
		} finally {
			child.kill();
			rmSync(directory, { recursive: true, force: true });
		}
	});
}
