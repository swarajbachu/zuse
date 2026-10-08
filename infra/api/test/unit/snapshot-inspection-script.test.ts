import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
	const root = mkdtempSync(join(tmpdir(), "snapshot inspection-"));
	roots.push(root);
	const repo = join(root, "repo with spaces");
	const bin = join(root, "bin");
	mkdirSync(repo);
	mkdirSync(bin);
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", repo, ...args], {
			encoding: "utf8",
			stdio: "pipe",
		}).trim();
	git("init", "-b", "main");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.test");
	writeFileSync(join(repo, "file"), "initial");
	git("add", ".");
	git("commit", "-m", "initial");
	git("remote", "add", "origin", "git@github.com:acme/repo.git");
	const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	writeFileSync(
		join(bin, "git"),
		`#!/bin/bash\nif [[ "$3" == ls-remote ]]; then if [[ -n "$TEST_GIT_ERROR" ]]; then echo "$TEST_GIT_ERROR" >&2; exit 1; fi; exit 0; fi\nexec '${realGit}' "$@"\n`,
		{ mode: 0o700 },
	);
	// Login CLIs are stubbed so inspection never reaches the network.
	writeFileSync(
		join(bin, "gh"),
		`#!/bin/bash\nif [[ -n "$TEST_LOGGED_OUT" ]]; then echo "HTTP 401: Requires authentication" >&2; exit 1; fi\necho octo-cat\n`,
		{ mode: 0o700 },
	);
	writeFileSync(
		join(bin, "claude"),
		`#!/bin/bash\nif [[ -n "$TEST_LOGGED_OUT" ]]; then echo '{"loggedIn":false}'; exit 1; fi\necho '{"loggedIn":true,"email":"dev@example.test"}'\n`,
		{ mode: 0o700 },
	);
	writeFileSync(
		join(bin, "codex"),
		`#!/bin/bash\nif [[ -n "$TEST_LOGGED_OUT" ]]; then echo "Not logged in" >&2; exit 1; fi\necho "Logged in using ChatGPT" >&2\n`,
		{ mode: 0o700 },
	);
	writeFileSync(
		join(root, "manifest.json"),
		JSON.stringify({ schemaVersion: 1, runtimeUser: userInfo().username }),
	);
	writeFileSync(
		join(root, "metadata.json"),
		JSON.stringify({ snapshotSupportVersion: 1, wireProtocolVersion: 5 }),
	);
	const script = readFileSync(
		new URL("../../../cloud-sandboxes/snapshot-inspect.sh", import.meta.url),
		"utf8",
	)
		.replace("/opt/zuse/node/bin/node", `'${process.execPath}'`)
		.replace("/etc/zuse/snapshot.json", join(root, "manifest.json"))
		.replace("/opt/zuse/current/bin.mjs", join(root, "metadata.json"))
		.replace(
			"/opt/zuse/current/runtime-metadata.json",
			join(root, "metadata.json"),
		);
	writeFileSync(
		join(root, "inspect.sh"),
		script.replace(
			"[user.homedir, '/workspace', '/workspaces', '/home', '/app', '/srv']",
			JSON.stringify([root]),
		),
	);
	const inspect = (paths = [repo], error = "", loggedOut = false) => {
		execFileSync("bash", [join(root, "inspect.sh")], {
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				ZUSE_SNAPSHOT_PATHS: JSON.stringify(paths),
				ZUSE_SNAPSHOT_RESULT: join(root, "result.json"),
				TEST_GIT_ERROR: error,
				TEST_LOGGED_OUT: loggedOut ? "1" : "",
			},
			stdio: "pipe",
		});
		return JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
	};
	return { root, repo, git, inspect };
};
test("inspection finds a mapped checkout and preserves staged files, native config and remotes", () => {
	const { repo, git, inspect } = fixture();
	writeFileSync(join(repo, "file"), "staged");
	git("add", "file");
	writeFileSync(join(repo, "untracked"), "keep");
	git("config", "credential.helper", "native");
	const result = inspect();
	expect(result.error).toBeUndefined();
	expect(result.repositories).toMatchObject([
		{ path: repo, identity: "github.com/acme/repo", gitAccess: "readable" },
	]);
	expect(git("show", ":file")).toBe("staged");
	expect(readFileSync(join(repo, "untracked"), "utf8")).toBe("keep");
	expect(git("config", "credential.helper")).toBe("native");
	expect(git("remote", "get-url", "origin")).toBe(
		"git@github.com:acme/repo.git",
	);
});
test.each([
	["Authentication failed", "authentication-required"],
	["Could not resolve host: github.com", "unavailable"],
])("inspection distinguishes %s", (error, status) => {
	const { repo, inspect } = fixture();
	expect(inspect([repo], error).repositories[0].gitAccess).toBe(status);
});
test("inspection reports the GitHub user and agent accounts without tokens", () => {
	const { repo, inspect } = fixture();
	const result = inspect();
	expect(result.github).toEqual({ state: "authenticated", login: "octo-cat" });
	expect(result.agents).toEqual([
		{ providerId: "claude", state: "detected", account: "dev@example.test" },
		{ providerId: "codex", state: "detected", account: "ChatGPT" },
	]);
	const signedOut = inspect([repo], "", true);
	expect(signedOut.github).toEqual({ state: "authentication-required" });
	expect(signedOut.agents).toEqual([
		{ providerId: "claude", state: "authentication-required" },
		{ providerId: "codex", state: "authentication-required" },
	]);
});
test("invalid explicit paths fail instead of choosing a different repository", () => {
	const { root, inspect } = fixture();
	expect(inspect([root]).error).toBe("snapshot-repository-invalid");
});
test("installer takes no repository or credential arguments", () => {
	const script = new URL(
		"../../../cloud-sandboxes/install-snapshot.sh",
		import.meta.url,
	).pathname;
	expect(execFileSync("bash", [script, "--help"], { encoding: "utf8" })).toBe(
		"Usage: bash install-snapshot.sh [--user development-user]\n",
	);
	expect(() =>
		execFileSync(
			"bash",
			[script, "--repo", "https://github.com/acme/repo=/app"],
			{ stdio: "pipe" },
		),
	).toThrow();
	execFileSync("bash", ["-n", script]);
});

test("automatic discovery skips an unwritable checkout; explicit paths report it", () => {
	const { root, repo, inspect } = fixture();
	const blocked = join(root, "blocked");
	mkdirSync(join(blocked, ".git"), { recursive: true });
	chmodSync(blocked, 0o500);
	try {
		const automatic = inspect([]);
		expect(automatic.error).toBeUndefined();
		expect(
			automatic.repositories.map((entry: { path: string }) => entry.path),
		).toEqual([repo]);
		expect(inspect([blocked]).error).toBe("snapshot-repository-not-writable");
	} finally {
		chmodSync(blocked, 0o700);
	}
});
test("an explicitly requested missing path has an actionable error", () => {
	const { root, inspect } = fixture();
	expect(inspect([join(root, "missing")]).error).toBe(
		"snapshot-repository-invalid",
	);
});
