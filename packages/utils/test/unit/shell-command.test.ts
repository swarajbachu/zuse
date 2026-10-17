import { describe, expect, it } from "vitest";
import {
	scriptCommandForPlatform,
	shellCommandForPlatform,
} from "../../src/shell-command.js";

describe("platform shell commands", () => {
	it("uses cmd.exe and COMSPEC on Windows", () => {
		expect(shellCommandForPlatform("win32", {})).toEqual({
			command: "cmd.exe",
			args: ["/d", "/s", "/c"],
		});
		expect(
			scriptCommandForPlatform("win32", "bun run dev", {
				COMSPEC: "C:\\Windows\\System32\\cmd.exe",
			}),
		).toEqual({
			command: "C:\\Windows\\System32\\cmd.exe",
			args: ["/d", "/s", "/c", "bun run dev"],
		});
	});

	it("keeps native login shells on macOS and Linux", () => {
		expect(shellCommandForPlatform("darwin", {})).toEqual({
			command: "/bin/zsh",
			args: ["-lc"],
		});
		expect(
			shellCommandForPlatform("linux", { SHELL: "/usr/bin/fish" }),
		).toEqual({
			command: "/usr/bin/fish",
			args: ["-lc"],
		});
	});
});
