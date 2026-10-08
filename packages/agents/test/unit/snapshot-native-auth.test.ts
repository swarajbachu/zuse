import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	exec: vi.fn(),
	start: vi.fn(),
	request: vi.fn(),
	close: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFile: mocks.exec }));
vi.mock("../../src/drivers/codex-app-server-client.ts", () => ({
	CodexAppServerClient: { start: mocks.start },
}));

import { checkSnapshotAgentAccess } from "../../src/drivers/snapshot-native-auth.ts";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.start.mockResolvedValue({ request: mocks.request, close: mocks.close });
});
test("Codex account configuration is detected, never reported as verified token usability", async () => {
	mocks.request.mockResolvedValue({ account: { type: "chatgpt" } });
	expect(await checkSnapshotAgentAccess("codex")).toBe("detected");
	expect(mocks.request).toHaveBeenCalledWith("account/read", {
		refreshToken: true,
	});
	expect(mocks.close).toHaveBeenCalledOnce();
});
test("copied OAuth refresh invalidation is visible and is not synchronized to another workspace", async () => {
	mocks.request.mockRejectedValue(new Error("refresh token was already used"));
	expect(await checkSnapshotAgentAccess("codex")).toBe("expired");
	expect(mocks.close).toHaveBeenCalledOnce();
	expect(mocks.request).toHaveBeenCalledTimes(1);
});
test("network failures stay retryable", async () => {
	mocks.request.mockRejectedValue(new Error("network unavailable"));
	expect(await checkSnapshotAgentAccess("codex")).toBe("unavailable");
});
test("missing login is distinct from unavailable checks", async () => {
	mocks.request.mockResolvedValue({ account: null });
	expect(await checkSnapshotAgentAccess("codex")).toBe(
		"authentication-required",
	);
});
test("Claude reports only detected configuration and checks no account authority", async () => {
	mocks.exec.mockImplementation((_cmd, _args, _options, callback) =>
		callback(null, JSON.stringify({ loggedIn: true })),
	);
	expect(await checkSnapshotAgentAccess("claude")).toBe("detected");
	expect(mocks.start).not.toHaveBeenCalled();
});
test("a missing Claude executable has actionable status", async () => {
	mocks.exec.mockImplementation((_cmd, _args, _options, callback) =>
		callback({ code: "ENOENT" }, ""),
	);
	expect(await checkSnapshotAgentAccess("claude")).toBe("missing-tool");
});
