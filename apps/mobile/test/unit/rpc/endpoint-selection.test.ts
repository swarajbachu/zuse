import { type ApiConnectGrant, WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import { chooseGrantEndpoint } from "../../../src/rpc/endpoint-selection";

const grant: ApiConnectGrant = {
	endpoint: {
		httpBaseUrl: "https://managed.test",
		wsBaseUrl: "wss://managed.test",
	},
	endpointCandidates: [
		{
			kind: "private-network",
			endpoint: {
				httpBaseUrl: "http://100.64.0.8:47837",
				wsBaseUrl: "ws://100.64.0.8:47837",
			},
		},
		{
			kind: "managed-tunnel",
			endpoint: {
				httpBaseUrl: "https://managed.test",
				wsBaseUrl: "wss://managed.test",
			},
		},
	],
	connectToken: "token",
	expiresAt: Date.now() + 60_000,
};

afterEach(() => vi.unstubAllGlobals());

describe("cloud endpoint selection", () => {
	test("uses a healthy private endpoint", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({
					status: "ok",
					wireProtocolVersion: WIRE_PROTOCOL_VERSION,
				}),
			})),
		);

		expect(await chooseGrantEndpoint(grant)).toEqual(
			grant.endpointCandidates?.[0]?.endpoint,
		);
	});

	test("falls back to the managed tunnel when the private probe fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Promise.reject(new Error("offline"))),
		);

		expect(await chooseGrantEndpoint(grant)).toEqual(
			grant.endpointCandidates?.[1]?.endpoint,
		);
	});
});
