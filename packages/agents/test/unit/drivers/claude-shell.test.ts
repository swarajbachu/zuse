import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
	claudeZshTarget,
	claudeZshWrapperScript,
	withClaudeZshShell,
} from "../../../src/drivers/claude-shell.ts";

const dirs: string[] = [];
const tempDir = async () => {
	const dir = await mkdtemp(join(tmpdir(), "claude-shell-"));
	dirs.push(dir);
	return dir;
};

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("Claude zsh shell", () => {
	it("targets only an absolute zsh login shell", () => {
		expect(claudeZshTarget({ SHELL: "/bin/zsh" }, "darwin")).toBe("/bin/zsh");
		expect(claudeZshTarget({ SHELL: "/opt/homebrew/bin/zsh" }, "linux")).toBe(
			"/opt/homebrew/bin/zsh",
		);
		expect(claudeZshTarget({ SHELL: "/bin/bash" }, "darwin")).toBeNull();
		expect(claudeZshTarget({ SHELL: "zsh" }, "darwin")).toBeNull();
		expect(claudeZshTarget({}, "darwin")).toBeNull();
		expect(claudeZshTarget({ SHELL: "/bin/zsh" }, "win32")).toBeNull();
	});

	it("respects an explicit Claude Code shell override", () => {
		expect(
			claudeZshTarget(
				{ SHELL: "/bin/zsh", CLAUDE_CODE_SHELL: "/bin/bash" },
				"darwin",
			),
		).toBeNull();
	});

	it("quotes the zsh path in the wrapper", () => {
		expect(claudeZshWrapperScript("/Users/o'neil/bin/zsh")).toContain(
			`exec '/Users/o'\\''neil/bin/zsh' -o NO_NOMATCH "$@"`,
		);
	});

	it("leaves non-zsh environments unchanged", async () => {
		const dir = await tempDir();
		const env = { SHELL: "/bin/bash" };
		expect(await Effect.runPromise(withClaudeZshShell(env, dir))).toBe(env);
	});

	it("keeps the environment when the wrapper cannot be written", async () => {
		const dir = await tempDir();
		const blocked = join(dir, "file");
		await writeFile(blocked, "");
		const env = { SHELL: "/bin/zsh" };
		expect(
			await Effect.runPromise(withClaudeZshShell(env, join(blocked, "x"))),
		).toEqual(env);
	});

	it("removes the temporary wrapper when installing it fails", async () => {
		const dir = await tempDir();
		const first = await Effect.runPromise(
			withClaudeZshShell({ SHELL: "/bin/zsh" }, dir),
		);
		const wrapper = first.CLAUDE_CODE_SHELL as string;
		await rm(wrapper);
		await mkdir(join(wrapper, "occupied"), { recursive: true });
		const env = { SHELL: "/bin/zsh" };
		expect(await Effect.runPromise(withClaudeZshShell(env, dir))).toEqual(env);
		expect(
			(await readdir(dir)).filter((name) => name.endsWith(".tmp")),
		).toEqual([]);
	});

	it.skipIf(process.platform === "win32")(
		"makes the wrapper executable under a restrictive umask",
		async () => {
			const dir = await tempDir();
			const previous = process.umask(0o177);
			try {
				const env = await Effect.runPromise(
					withClaudeZshShell({ SHELL: "/bin/zsh" }, dir),
				);
				const mode = (await stat(env.CLAUDE_CODE_SHELL as string)).mode;
				expect(mode & 0o777).toBe(0o700);
			} finally {
				process.umask(previous);
			}
		},
	);

	it.skipIf(process.platform === "win32" || !existsSync("/bin/zsh"))(
		"passes unmatched globs through like bash",
		async () => {
			const dir = await tempDir();
			const env = await Effect.runPromise(
				withClaudeZshShell({ SHELL: "/bin/zsh" }, dir),
			);
			const wrapper = env.CLAUDE_CODE_SHELL;
			expect(wrapper).toBeDefined();
			expect(wrapper).toContain("zsh");
			expect((await stat(wrapper as string)).mode & 0o777).toBe(0o700);
			expect(await readFile(wrapper as string, "utf8")).toBe(
				claudeZshWrapperScript("/bin/zsh"),
			);
			const output = execFileSync(
				wrapper as string,
				["-c", "echo --include=*.zuse-no-such-ext"],
				{ cwd: dir, encoding: "utf8" },
			);
			expect(output.trim()).toBe("--include=*.zuse-no-such-ext");

			const again = await Effect.runPromise(
				withClaudeZshShell({ SHELL: "/bin/zsh" }, dir),
			);
			expect(again.CLAUDE_CODE_SHELL).toBe(wrapper);
		},
	);
});
