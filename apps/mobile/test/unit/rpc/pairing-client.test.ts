import { afterEach, describe, expect, test, vi } from "vitest";

import { redeemPairingCode } from "../../../src/rpc/pairing-client";

describe("pairing client", () => {
	afterEach(() => vi.useRealTimers());

	test("times out an unreachable desktop with a recovery message", async () => {
		vi.useFakeTimers();
		const pending = redeemPairingCode({
			host: "desktop.local",
			port: 8788,
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
