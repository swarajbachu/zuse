import { beforeEach, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:util", () => ({ promisify: () => execute }));

import { readCurrentCredential, readKeychain } from "../credentials.ts";

beforeEach(() => {
	execute.mockReset();
});
it("uses a bounded, shell-free read of the exact login item", async () => {
	execute.mockResolvedValue({
		stdout: '{"claudeAiOauth":{"accessToken":"private"}}',
	});
	const signal = new AbortController().signal;
	expect(
		await readKeychain("Claude Code-credentials", undefined, signal),
	).toMatchObject({ claudeAiOauth: { accessToken: "private" } });
	expect(execute).toHaveBeenCalledExactlyOnceWith(
		"/usr/bin/security",
		["find-generic-password", "-s", "Claude Code-credentials", "-w"],
		{ encoding: "utf8", timeout: 15000, maxBuffer: 65536, signal },
	);
});
it("does not expose security stderr or return malformed/oversized credential output", async () => {
	execute.mockRejectedValue({ code: 36, stderr: "private-token" });
	await expect(
		readKeychain("Codex Auth", "cli|fixture", new AbortController().signal),
	).rejects.toThrow("Keychain access was denied");
	execute.mockResolvedValue({ stdout: "invalid-json-private-token" });
	await expect(
		readKeychain("Codex Auth", "cli|fixture", new AbortController().signal),
	).rejects.toThrow("saved login is unreadable");
	execute.mockRejectedValue({
		code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
		stdout: "private-token",
	});
	await expect(
		readKeychain("Codex Auth", "cli|fixture", new AbortController().signal),
	).rejects.toThrow("Keychain access was denied");
});
it("reports a missing login when the specific Keychain entry and file are absent", async () => {
	execute.mockRejectedValue({ code: 44 });
	await expect(
		readCurrentCredential("claude", new AbortController().signal, {
			platform: "darwin",
			home: "/fixture-missing",
			env: {},
		}),
	).rejects.toThrow("No Claude Code login found");
	expect(execute).toHaveBeenCalledTimes(1);
});
