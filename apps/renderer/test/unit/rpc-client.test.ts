import { describe, expect, it, vi } from "vitest";

const locationValue = { host: "localhost:8787", reload: vi.fn() };
const storage = new Map<string, string>();

Object.defineProperty(globalThis, "location", {
	value: locationValue,
	configurable: true,
});
Object.defineProperty(globalThis, "localStorage", {
	value: {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	},
	configurable: true,
});

const {
	connectionTargetForScopeForTest,
	getActiveEnvironmentId,
	resolveRendererRpcTransportForTest,
	selectEnvironment,
	webSocketConnectionOwnerForTest,
} = await import("../../src/lib/rpc-client.ts");

describe("renderer RPC transport selection", () => {
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

	it("reports hosted and remote socket closes to their owning supervisors", () => {
		expect(webSocketConnectionOwnerForTest("browser")).toBe("control-plane");
		expect(webSocketConnectionOwnerForTest("remote")).toBe("environment");
	});

	it("stores only the environment id and reloads for a clean switch", async () => {
		await selectEnvironment("env_cloud_1");

		expect(getActiveEnvironmentId()).toBe("env_cloud_1");
		expect([...storage.entries()]).toEqual([
			["zuse.active-environment-id", "env_cloud_1"],
		]);
		expect(locationValue.reload).toHaveBeenCalledOnce();

		await selectEnvironment(null);
		expect(getActiveEnvironmentId()).toBeNull();
		expect(storage.size).toBe(0);
		expect(locationValue.reload).toHaveBeenCalledTimes(2);
	});

	it("keeps shell operations on the local control plane after a cloud switch", async () => {
		await selectEnvironment("env_cloud_1");

		expect(connectionTargetForScopeForTest("control-plane")).toBe(
			"control-plane",
		);
		expect(connectionTargetForScopeForTest("environment")).toBe(
			"environment:env_cloud_1",
		);

		await selectEnvironment(null);
	});
});
