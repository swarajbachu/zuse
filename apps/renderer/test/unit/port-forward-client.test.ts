import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	prepare: vi.fn(),
	open: vi.fn(),
	list: vi.fn(),
}));

vi.mock("../../src/lib/bridge.ts", () => ({
	getTunnelsBridge: () => ({
		list: mocks.list,
		open: mocks.open,
	}),
}));

vi.mock("../../src/lib/cloud-ssh-client-bus.ts", () => ({
	prepareCloudWorkspaceSsh: mocks.prepare,
}));

vi.mock("../../src/lib/rpc-client.ts", () => ({
	getLocalEnvironmentId: () => "local",
	isCloudWorkspaceEnvironment: () => true,
}));

import { ensurePortForward } from "../../src/lib/port-forward-client.ts";

describe("port forward client", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("reuses a live localhost forward before refreshing cloud access", async () => {
		mocks.list.mockResolvedValue([
			{ environmentId: "workspace_a", remotePort: 3000, localPort: 31_234 },
		]);
		expect(await ensurePortForward("workspace_a", 3000)).toBe(31_234);
		expect(mocks.prepare).not.toHaveBeenCalled();
		expect(mocks.open).not.toHaveBeenCalled();
	});

	it("performs at most one credential-refresh retry", async () => {
		mocks.list.mockResolvedValue([]);
		mocks.prepare.mockResolvedValue({});
		mocks.open
			.mockRejectedValueOnce(new Error("zuse ssh bridge: connection failed"))
			.mockResolvedValueOnce({
				environmentId: "workspace_a",
				remotePort: 3000,
				localPort: 30_000,
			});
		expect(await ensurePortForward("workspace_a", 3000)).toBe(30_000);
		expect(mocks.prepare).toHaveBeenCalledTimes(2);
		expect(mocks.open).toHaveBeenCalledTimes(2);
	});

	it("does not refresh credentials for local port allocation failures", async () => {
		mocks.list.mockResolvedValue([]);
		mocks.prepare.mockResolvedValue({});
		mocks.open.mockRejectedValue(new Error("bind: Address already in use"));
		await expect(ensurePortForward("workspace_a", 3000)).rejects.toThrow(
			"Address already in use",
		);
		expect(mocks.prepare).toHaveBeenCalledTimes(1);
		expect(mocks.open).toHaveBeenCalledTimes(1);
	});
});
