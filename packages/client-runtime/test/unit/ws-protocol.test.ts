import { describe, expect, it, vi } from "vitest";
import {
	authenticatedWsUrl,
	observeWebSocketConstructor,
} from "../../src/ws-protocol.ts";

describe("WebSocket client protocol", () => {
	it("builds one authenticated wire-versioned endpoint for every client", () => {
		expect(
			authenticatedWsUrl({
				host: " 127.0.0.1 ",
				port: 8787,
				token: " token-value ",
			}),
		).toBe("ws://127.0.0.1:8787/?token=token-value&wireVersion=5");
	});

	it("prefers a managed base URL", () => {
		expect(
			authenticatedWsUrl({
				host: "ignored",
				port: 1,
				wsBaseUrl: "wss://environment.example/rpc",
			}),
		).toBe("wss://environment.example/rpc?wireVersion=5");
	});

	it("reports an established socket closing to the connection owner", () => {
		const socket = new EventTarget();
		const onClose = vi.fn();
		const make = observeWebSocketConstructor(
			() => socket as unknown as WebSocket,
			onClose,
		);

		expect(make("wss://environment.example/rpc")).toBe(socket);
		socket.dispatchEvent(new CloseEvent("close", { code: 1006 }));

		expect(onClose).toHaveBeenCalledOnce();
		expect(onClose).toHaveBeenCalledWith(
			expect.objectContaining({ code: 1006 }),
		);
	});
});
