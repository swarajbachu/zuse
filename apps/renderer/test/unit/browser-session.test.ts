import { afterEach, describe, expect, it, vi } from "vitest";

import {
	exchangeBrowserPairing,
	readAndClearPairingFragment,
	requestBrowserWebSocketUrl,
} from "../../src/lib/browser-session.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("browser sessions", () => {
	it("reads the pairing credential and immediately removes the fragment", () => {
		const replaceState = vi.fn();
		const credential = readAndClearPairingFragment(
			{
				hash: "#pair=zp_secret",
				pathname: "/projects/example",
				search: "?tab=chat",
			} as Location,
			{ replaceState } as unknown as History,
		);
		expect(credential).toBe("zp_secret");
		expect(replaceState).toHaveBeenCalledWith(
			null,
			"",
			"/projects/example?tab=chat",
		);
	});

	it("exchanges pairing credentials without exposing them in a URL", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({ authenticated: true, authRequired: true }),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		await expect(exchangeBrowserPairing("zp_secret")).resolves.toMatchObject({
			authenticated: true,
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"/auth/browser-session",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ credential: "zp_secret" }),
				credentials: "same-origin",
			}),
		);
	});

	it("uses a fresh ticket and secure same-origin WebSocket URL", async () => {
		vi.stubGlobal("window", {
			location: {
				href: "https://serve.example.test/projects",
				protocol: "https:",
				host: "serve.example.test",
			},
		} as unknown as Window);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ ticket: "zws_once" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			),
		);
		await expect(requestBrowserWebSocketUrl()).resolves.toBe(
			"wss://serve.example.test/rpc?ticket=zws_once",
		);
	});
});
