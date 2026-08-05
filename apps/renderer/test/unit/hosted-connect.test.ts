import { describe, expect, it, vi } from "vitest";

import {
	createHostedEndpointLease,
	hostedAuthTokenEndpoint,
	isHostedProduct,
	resolveHostedWorkosClientId,
} from "../../src/lib/hosted-connect.ts";

const STAGING_CLIENT_ID = "client_01KW6ZEZKVMZ0G429A89XZD83Q";
const PRODUCTION_CLIENT_ID = "client_01KWGQ818571ARFATQ3G9AR2Y2";

describe("hosted authentication", () => {
	it("exchanges browser tokens through the configured relay", () => {
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
