import { EnvironmentId, FolderId } from "@zuse/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/environment-shell-client-bus.ts", () => ({
	dispatchEnvironmentShellCommand: dispatch,
}));
vi.mock("../../src/store/environment-catalog.ts", () => ({
	useEnvironmentCatalogStore: {
		getState: () => ({ activeEnvironmentId: "local" }),
	},
}));
vi.mock("../../src/lib/runtime-operation-client.ts", () => ({
	runtimeOperationClient: vi.fn(),
}));

import { useMcpStore } from "../../src/store/mcp.ts";

beforeEach(() => {
	dispatch.mockReset();
	useMcpStore.setState({
		environmentId: null,
		servers: [],
		statuses: new Map(),
		loaded: false,
		error: null,
	});
});
describe("cloud runtime MCP settings", () => {
	it("loads and updates the explicitly selected runtime instead of the account shell", async () => {
		dispatch.mockResolvedValue({ result: { servers: [], statuses: [] } });
		const environmentId = EnvironmentId.make("cloud-workspace-1");
		const projectId = FolderId.make("runtime-folder");
		await useMcpStore
			.getState()
			.load({ environmentId, projectId, provider: "claude" });
		expect(dispatch).toHaveBeenLastCalledWith(
			expect.objectContaining({
				environmentId,
				kind: "mcp.list",
				payload: { projectId, provider: "claude" },
			}),
		);
		await useMcpStore.getState().setEnabled("server", false, projectId);
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				environmentId,
				kind: "mcp.setEnabled",
				payload: { key: "server", enabled: false, projectId },
			}),
		);
		expect(
			dispatch.mock.calls.every(
				([command]) => command.environmentId === environmentId,
			),
		).toBe(true);
	});
	it("rejects a stale inventory after switching runtimes", async () => {
		let finish: ((value: unknown) => void) | undefined;
		dispatch.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const pending = useMcpStore
			.getState()
			.load({ environmentId: EnvironmentId.make("old") });
		dispatch.mockResolvedValueOnce({ result: { servers: [], statuses: [] } });
		await useMcpStore
			.getState()
			.load({ environmentId: EnvironmentId.make("new") });
		finish?.({ result: { servers: [{ key: "stale" }], statuses: [] } });
		await pending;
		expect(useMcpStore.getState().servers).toEqual([]);
	});
	it("does not refresh a new runtime after an old mutation completes", async () => {
		const old = EnvironmentId.make("old");
		const next = EnvironmentId.make("new");
		useMcpStore.setState({ environmentId: old });
		let finish: ((value: unknown) => void) | undefined;
		dispatch.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const pending = useMcpStore
			.getState()
			.setEnabled("server", false, FolderId.make("old-folder"));
		useMcpStore.setState({ environmentId: next });
		finish?.({ result: {} });
		await pending;
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(useMcpStore.getState().environmentId).toBe(next);
	});
});
