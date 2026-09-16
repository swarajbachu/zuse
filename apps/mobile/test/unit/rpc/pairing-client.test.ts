import { afterEach, describe, expect, test, vi } from "vitest";

import { redeemPairingCode } from "../../../src/rpc/pairing-client";

vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));

describe("pairing client", () => {
	afterEach(() => vi.useRealTimers());

	test.each([
		undefined,
		"",
		"not-a-url",
		"http://192.168.1.2:47837",
		"http://desktop.example.ts.net",
		"https://user:password@desktop.example.ts.net",
		"https://desktop.example.ts.net?redirect=http://example.com",
		"https://desktop.example.ts.net#fragment",
	])("rejects unsafe pairing endpoint %s before sending credentials", async (httpBaseUrl) => {
		const fetchImpl = vi.fn<typeof fetch>();
		await expect(
			redeemPairingCode({
				host: "192.168.1.2",
				port: 47837,
				code: "ABCD2345",
				deviceId: "phone",
				deviceLabel: "Phone",
				httpBaseUrl,
				fetchImpl,
			}),
		).rejects.toThrow("secure HTTPS connection URL");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	test("posts short codes over HTTPS without allowing redirects", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response(JSON.stringify({ token: "zt_token" }), { status: 200 }),
			);
		await redeemPairingCode({
			host: "desktop.example.ts.net",
			port: 443,
			code: "ABCD2345",
			deviceId: "phone",
			deviceLabel: "Phone",
			httpBaseUrl: "https://desktop.example.ts.net/",
			fetchImpl,
		});
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://desktop.example.ts.net/pair",
			expect.objectContaining({
				method: "POST",
				redirect: "error",
				body: JSON.stringify({
					code: "ABCD2345",
					deviceId: "phone",
					deviceLabel: "Phone",
				}),
			}),
		);
	});

	test("times out an unreachable desktop with a recovery message", async () => {
		vi.useFakeTimers();
		const pending = redeemPairingCode({
			host: "desktop.local",
			port: 8788,
			httpBaseUrl: "https://desktop.example.ts.net",
			code: "zp_code",
			deviceId: "phone",
			deviceLabel: "Phone",
			timeoutMs: 25,
			fetchImpl: ((_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("Aborted", "AbortError")),
					);
				})) as typeof fetch,
		});
		const assertion = expect(pending).rejects.toThrow("did not respond");
		await vi.advanceTimersByTimeAsync(25);
		await assertion;
	});

	test("returns a redeemed credential", async () => {
		await expect(
			redeemPairingCode({
				host: "desktop.local",
				port: 8788,
				httpBaseUrl: "https://desktop.example.ts.net",
				code: "zp_code",
				deviceId: "phone",
				deviceLabel: "Phone",
				fetchImpl: vi.fn(
					async () =>
						new Response(JSON.stringify({ token: "zt_token" }), {
							status: 200,
						}),
				) as typeof fetch,
			}),
		).resolves.toEqual({ token: "zt_token" });
	});
});
