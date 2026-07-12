import { describe, expect, it } from "vitest";
import { authenticatedWsUrl } from "../../src/ws-protocol.ts";

describe("WebSocket client protocol", () => {
	it("builds one authenticated wire-versioned endpoint for every client", () => {
		expect(
			authenticatedWsUrl({
				host: " 127.0.0.1 ",
				port: 8787,
				token: " token-value ",
			}),
		).toBe("ws://127.0.0.1:8787/?token=token-value&wireVersion=2");
	});

	it("prefers a managed base URL", () => {
		expect(
			authenticatedWsUrl({
				host: "ignored",
				port: 1,
				wsBaseUrl: "wss://environment.example/rpc",
			}),
		).toBe("wss://environment.example/rpc?wireVersion=2");
	});
});
