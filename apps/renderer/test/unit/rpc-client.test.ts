import { describe, expect, it } from "vitest";

const locationValue = { host: "localhost:8787" };

Object.defineProperty(globalThis, "location", {
	value: locationValue,
	configurable: true,
});

const { RENDERER_WEBSOCKET_OPEN_TIMEOUT, resolveRendererRpcTransportForTest } =
	await import("../../src/lib/rpc-client.ts");

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
});
