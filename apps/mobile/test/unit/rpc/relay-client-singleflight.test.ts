import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../src/auth/config.ts", () => ({
	relayBaseUrl: () => "https://relay.example",
}));
vi.mock("../../../src/auth/dpop.ts", () => ({
	devicePublicJwk: vi.fn(),
	signDpopProof: vi.fn(async () => "proof"),
}));
vi.mock("../../../src/auth/workos.ts", () => ({
	getAccessToken: vi.fn(async () => "workos-token"),
}));

const flushPromises = async (): Promise<void> => {
	for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

describe("relay DPoP token refresh", () => {
	beforeEach(async () => {
		vi.restoreAllMocks();
		const { resetRelayAccessToken } = await import(
			"../../../src/rpc/relay-client"
		);
		resetRelayAccessToken();
	});

	test("shares one token exchange across concurrent connect requests", async () => {
		let releaseToken!: () => void;
		const tokenGate = new Promise<void>((resolve) => {
			releaseToken = resolve;
		});
		let tokenRequests = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const requestUrl = String(input);
				if (requestUrl.endsWith("/v1/client/dpop-token")) {
					tokenRequests += 1;
					await tokenGate;
					return Response.json({
						accessToken: "relay-token",
						expiresIn: 60_000,
					});
				}
				return Response.json({
					endpoint: {
						host: "environment.example",
						port: 443,
						wsBaseUrl: "wss://environment.example",
						httpBaseUrl: "https://environment.example",
					},
					connectToken: "connect-token",
					expiresAt: Date.now() + 60_000,
				});
			}),
		);
		const { connectEnvironment } = await import(
			"../../../src/rpc/relay-client"
		);

		const requests = [connectEnvironment("env_1"), connectEnvironment("env_1")];
		await flushPromises();
		expect(tokenRequests).toBe(1);
		releaseToken();
		await expect(Promise.all(requests)).resolves.toHaveLength(2);
	});
});
