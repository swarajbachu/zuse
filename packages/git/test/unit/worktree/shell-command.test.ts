import { describe, expect, it } from "vitest";

import { shellCommandForPlatform } from "../../../src/worktree/worktree-service-live.ts";

describe("worktree script shell", () => {
	it("uses the configured shell on Linux", () => {
		expect(
			shellCommandForPlatform("linux", { SHELL: "/usr/bin/fish" }),
		).toEqual({
			command: "/usr/bin/fish",
			args: ["-lc"],
		});
	});

	it("falls back to a portable POSIX shell on Linux", () => {
		expect(shellCommandForPlatform("linux", {})).toEqual({
			command: "/bin/sh",
			args: ["-lc"],
		});
	});

	it("keeps zsh as the macOS fallback", () => {
		expect(shellCommandForPlatform("darwin", {})).toEqual({
			command: "/bin/zsh",
			args: ["-lc"],
		});
	});
});
