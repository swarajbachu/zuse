import { describe, expect, it } from "vitest";

const locationValue = { host: "localhost:8787" };

Object.defineProperty(globalThis, "location", {
	value: locationValue,
	configurable: true,
});

const {
	RENDERER_WEBSOCKET_OPEN_TIMEOUT,
	resolveRendererRpcTransportForTest,
	shouldReconnectRendererConnection,
	shouldRestartCloudWorkspaceConnection,
} = await import("../../src/lib/rpc-client.ts");

describe("renderer RPC transport selection", () => {
	it("bounds the WebSocket opening phase", () => {
		expect(RENDERER_WEBSOCKET_OPEN_TIMEOUT).toBe("3 seconds");
	});
	it("uses WebSocket mode when no Electron bridge is present", () => {
		Object.defineProperty(globalThis, "window", {
			value: {},
			configurable: true,
		});

		expect(resolveRendererRpcTransportForTest()).toEqual({
			kind: "websocket",
			wsUrl: "ws://localhost:8787/rpc",
		});
	});

	it("keeps Electron IPC mode when the preload bridge is present", () => {
		Object.defineProperty(globalThis, "window", {
			value: { zuse: { rpc: {} } },
			configurable: true,
		});

		expect(resolveRendererRpcTransportForTest()).toEqual({ kind: "electron" });
	});

	it("restarts stale cloud attachments when a fresh grant is registered", () => {
		expect(shouldRestartCloudWorkspaceConnection("connecting")).toBe(true);
		expect(shouldRestartCloudWorkspaceConnection("reconnecting")).toBe(true);
		expect(shouldRestartCloudWorkspaceConnection("error")).toBe(true);
		expect(shouldRestartCloudWorkspaceConnection("blockedAuth")).toBe(true);
		expect(shouldRestartCloudWorkspaceConnection("connected")).toBe(false);
	});

	it("reconnects when a stable cloud gateway receives a fresh one-time grant", () => {
		const refresh = async () => ({
			workspaceId: "workspace-1",
			wsUrl: "wss://cloud.example/workspaces/workspace-1",
			protocol: "zuse-workspace-v1",
			credential: "new-grant",
			expiresAt: Date.now() + 60_000,
		});
		expect(
			shouldReconnectRendererConnection(
				{
					key: "workspace:workspace-1",
					kind: "websocket",
					wsUrl: "wss://cloud.example/workspaces/workspace-1",
					protocols: ["zuse-workspace-v1", "expired-grant"],
					refreshConnection: refresh,
				},
				{
					key: "workspace:workspace-1",
					kind: "websocket",
					wsUrl: "wss://cloud.example/workspaces/workspace-1",
					protocols: ["zuse-workspace-v1", "new-grant"],
					refreshConnection: refresh,
				},
			),
		).toBe(true);
	});
});
