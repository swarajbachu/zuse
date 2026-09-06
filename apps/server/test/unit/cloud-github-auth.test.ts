import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const auth = fileURLToPath(
	new URL("../../../../infra/cloud-sandboxes/github-auth.sh", import.meta.url),
);

test("installation repairs multiple helpers and overrides inherited stale credentials", async () => {
	const root = await mkdtemp(join(tmpdir(), "zuse-gh-repair-"));
	try {
		const token = join(root, "token");
		await writeFile(token, "current-token\n");
		const env = {
			...process.env,
			HOME: root,
			GIT_CONFIG_GLOBAL: join(root, ".gitconfig"),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
			ZUSE_GITHUB_TOKEN_FILE: token,
			ZUSE_GITHUB_AUTH_BIN: auth,
		};
		const run = (command: string, args: string[], input?: string) =>
			spawnSync(command, args, { env, encoding: "utf8", input });
		const stale = "!f() { printf 'username=old\\npassword=expired\\n'; }; f";
		for (const key of [
			"credential.helper",
			"credential.https://github.com.helper",
			"credential.https://github.com.helper",
		]) {
			expect(
				run("git", ["config", "--global", "--add", key, stale]).status,
			).toBe(0);
		}
		for (let attempt = 0; attempt < 2; attempt++) {
			const install = run("bash", [auth, "install"]);
			expect(install.status, install.stderr).toBe(0);
			const result = run(
				"git",
				["credential", "fill"],
				"protocol=https\nhost=github.com\n\n",
			);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("password=current-token");
			expect(result.stdout).not.toContain("expired");
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test.each([
	{ token: null, expiresAtMs: 4102444800000 },
	{ token: false, expiresAtMs: 4102444800000 },
	{ token: {}, expiresAtMs: 4102444800000 },
	{ token: "", expiresAtMs: 4102444800000 },
	{ token: "replacement", expiresAtMs: null },
	{ token: "replacement", expiresAtMs: 1 },
])("an invalid broker refresh preserves a still-valid token (%j)", async (response) => {
	const root = await mkdtemp(join(tmpdir(), "zuse-gh-refresh-"));
	try {
		const bin = join(root, "bin");
		await mkdir(bin);
		await writeFile(
			join(root, "github-broker.json"),
			'{"credentialUrl":"https://broker.test/token"}',
		);
		await writeFile(
			join(root, "cloud-runtime-credential"),
			"runtime-credential",
		);
		await writeFile(join(root, "github-installation-token"), "valid-token\n");
		await writeFile(
			join(root, "github-installation-token-expires-at"),
			`${Date.now() + 120_000}\n`,
		);
		await writeFile(
			join(bin, "curl"),
			"#!/bin/sh\nprintf '%s\\n' \"$BROKER_RESPONSE\"\n",
			{ mode: 0o755 },
		);
		const result = spawnSync("bash", [auth, "credential", "get"], {
			env: {
				...process.env,
				ZUSE_GITHUB_TOKEN_FILE: "",
				ZUSE_USER_DATA: root,
				BROKER_RESPONSE: JSON.stringify(response),
				PATH: `${bin}:${process.env.PATH}`,
			},
			encoding: "utf8",
			input: "protocol=https\nhost=github.com\n\n",
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("password=valid-token");
		expect(
			await readFile(join(root, "github-installation-token"), "utf8"),
		).toBe("valid-token\n");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
