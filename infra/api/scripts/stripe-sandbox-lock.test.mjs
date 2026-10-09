import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
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
/** Waits for readiness while bounding failures and preserving startup diagnostics. */
function waitUntilReady(child, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const finish = (error) => {
			clearTimeout(timer);
			child.stdout.removeListener("data", output);
			child.stderr.removeListener("data", diagnostic);
			child.removeListener("close", closed);
			child.removeListener("error", failed);
			if (error) reject(error);
			else resolve();
		};
		const output = (chunk) => {
			stdout += chunk;
			if (stdout.includes("ready\n")) finish();
		};
		const diagnostic = (chunk) => {
			stderr += chunk;
		};
		const closed = (code, signal) =>
			finish(
				new Error(
					`child exited before readiness (${code ?? signal}): ${stderr}`,
				),
			);
		const failed = (error) => finish(error);
		const timer = setTimeout(
			() => finish(new Error(`child readiness timeout: ${stderr}`)),
			timeoutMs,
		);
		child.stdout.on("data", output);
		child.stderr.on("data", diagnostic);
		child.once("close", closed);
		child.once("error", failed);
	});
}

test("restricts an existing artifact directory", () => {
	const directory = mkdtempSync(join(tmpdir(), "stripe-lock-"));
	try {
		chmodSync(directory, 0o755);
		const release = acquireRunnerLock(directory);
		try {
			assert.equal(statSync(directory).mode & 0o777, 0o700);
		} finally {
			release();
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("startup failure reports stderr without waiting forever", async () => {
	const child = spawn(process.execPath, [
		"-e",
		"console.error('startup failed'); process.exit(2)",
	]);
	await assert.rejects(
		waitUntilReady(child),
		/child exited before readiness.*startup failed/s,
	);
});

test("startup without a readiness message times out and permits cleanup", async () => {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
	const exited = once(child, "exit");
	try {
		await assert.rejects(waitUntilReady(child, 100), /readiness timeout/);
	} finally {
		child.kill();
		await exited;
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
			await waitUntilReady(child);
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
