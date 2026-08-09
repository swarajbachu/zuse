import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("the paid icon installer is a no-op without a license token", () => {
	const result = spawnSync(
		process.execPath,
		["scripts/install-paid-icons.mjs"],
		{
			cwd: process.cwd(),
			encoding: "utf8",
			env: { ...process.env, HUGEICONS_TOKEN: "" },
		},
	);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Using public icons/);
});

test("paid icon install failures are propagated without exposing the token", () => {
	const executableDirectory = mkdtempSync(join(tmpdir(), "zuse-fake-bun-"));
	const fakeBun = join(executableDirectory, "bun");
	writeFileSync(fakeBun, "#!/bin/sh\nexit 23\n");
	chmodSync(fakeBun, 0o755);
	const token = "test-token-that-must-stay-private";

	const result = spawnSync(
		process.execPath,
		["scripts/install-paid-icons.mjs"],
		{
			cwd: process.cwd(),
			encoding: "utf8",
			env: {
				...process.env,
				HUGEICONS_TOKEN: token,
				PATH: executableDirectory,
			},
		},
	);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /exit code 23/);
	assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(token));
});
