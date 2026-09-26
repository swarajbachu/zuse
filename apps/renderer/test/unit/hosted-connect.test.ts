import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createHostedEndpointLease,
	hostedAccessToken,
	hostedAuthTokenEndpoint,
	isHostedProduct,
	resolveHostedWorkosClientId,
} from "../../src/lib/hosted-connect.ts";

const STAGING_CLIENT_ID = "client_01KW6ZEZKVMZ0G429A89XZD83Q";
const PRODUCTION_CLIENT_ID = "client_01KWGQ818571ARFATQ3G9AR2Y2";

describe("hosted authentication", () => {
	it("exchanges browser tokens through the configured api", () => {
		expect(hostedAuthTokenEndpoint("http://127.0.0.1:8790/")).toBe(
			"http://127.0.0.1:8790/v1/auth/token",
		);
	});

	it("recognizes the canonical hosted product domain", () => {
		expect(isHostedProduct("https://code.zuse.sh")).toBe(true);
		expect(isHostedProduct("https://app.zuse.sh")).toBe(false);
	});

	it("uses the staging AuthKit client during development", () => {
		expect(resolveHostedWorkosClientId(undefined, true)).toBe(
			STAGING_CLIENT_ID,
		);
		expect(resolveHostedWorkosClientId(undefined, false)).toBe(
			PRODUCTION_CLIENT_ID,
		);
		expect(resolveHostedWorkosClientId("client_override", true)).toBe(
			"client_override",
		);
	});

	it("uses each connect grant once and refreshes it for reconnects", async () => {
		const lease = createHostedEndpointLease();
		const refresh = vi.fn(async (environmentId: string) => {
			lease.set(environmentId, "wss://host.example/rpc?token=fresh");
		});

		lease.set("env-1", "wss://host.example/rpc?token=initial");

		await expect(lease.next(refresh)).resolves.toBe(
			"wss://host.example/rpc?token=initial",
		);
		await expect(lease.next(refresh)).resolves.toBe(
			"wss://host.example/rpc?token=fresh",
		);
		expect(refresh).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledWith("env-1");
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
it("shares one refresh-token exchange between concurrent cloud requests", async () => {
	const storage = new Map([
		[
			"zuse.hosted.session.v1",
			JSON.stringify({
				accessToken: "expired",
				refreshToken: "rotate-once",
				expiresAt: 0,
			}),
		],
	]);
	vi.stubGlobal("sessionStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	});
	const fetch = vi.fn(async () =>
		Response.json({ access_token: "fresh-token", refresh_token: "rotated" }),
	);
	vi.stubGlobal("fetch", fetch);
	expect(
		await Promise.all([
			hostedAccessToken(),
			hostedAccessToken(),
			hostedAccessToken(),
		]),
	).toEqual(["fresh-token", "fresh-token", "fresh-token"]);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(
		JSON.parse(storage.get("zuse.hosted.session.v1") ?? "null").refreshToken,
	).toBe("rotated");
});
