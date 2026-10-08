import { describe, expect, it } from "vitest";
import { listenForCallback } from "../../src/mcp/mcp-oauth.ts";

const callbackUrl = (redirectUrl: string, params: Record<string, string>) => {
	const url = new URL(redirectUrl);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}
	return url.toString();
};

describe("mcp oauth loopback callback", () => {
	it("ignores callbacks that do not echo the per-flow state", async () => {
		const listener = await listenForCallback("Test MCP");
		try {
			// A callback with a foreign state must not resolve the flow.
			const foreign = await fetch(
				callbackUrl(listener.redirectUrl, {
					state: "foreign",
					code: "attacker_code",
				}),
			);
			expect(foreign.status).toBe(400);

			// The genuine redirect (matching state) still resolves.
			const codePromise = listener.waitForCode;
			const genuine = await fetch(
				callbackUrl(listener.redirectUrl, {
					state: listener.state,
					code: "real_code",
				}),
			);
			expect(genuine.status).toBe(200);
			await expect(codePromise).resolves.toBe("real_code");
		} finally {
			listener.close();
		}
	});

	it("rejects a missing state parameter without resolving", async () => {
		const listener = await listenForCallback("Test MCP");
		try {
			const res = await fetch(listener.redirectUrl);
			expect(res.status).toBe(400);
			const timedOut = await Promise.race([
				listener.waitForCode.then(() => "resolved").catch(() => "rejected"),
				new Promise<string>((resolve) =>
					setTimeout(() => resolve("pending"), 100),
				),
			]);
			expect(timedOut).toBe("pending");
		} finally {
			listener.close();
		}
	});
});
