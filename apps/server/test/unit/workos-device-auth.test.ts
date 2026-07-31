import { describe, expect, it } from "vitest";

import {
	pollDeviceAuthorization,
	requestDeviceAuthorization,
} from "../../src/auth/layers/workos-device-auth.ts";

const ACCESS_TOKEN = "eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDcyMDM2MDB9.signature";

describe("WorkOS device authorization", () => {
	it("requests a browserless device code", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetcher: typeof fetch = async (input, init) => {
			requests.push({ url: String(input), init });
			return Response.json({
				device_code: "device-secret",
				user_code: "ABCD-EFGH",
				verification_uri: "https://auth.example/device",
				verification_uri_complete:
					"https://auth.example/device?user_code=ABCD-EFGH",
				expires_in: 300,
				interval: 5,
			});
		};

		const grant = await requestDeviceAuthorization("client_123", fetcher);

		expect(grant).toEqual({
			deviceCode: "device-secret",
			userCode: "ABCD-EFGH",
			verificationUri: "https://auth.example/device",
			verificationUriComplete:
				"https://auth.example/device?user_code=ABCD-EFGH",
			expiresInSeconds: 300,
			intervalSeconds: 5,
		});
		expect(requests[0]?.url).toContain("/user_management/authorize/device");
		expect(String(requests[0]?.init?.body)).toBe("client_id=client_123");
	});

	it("respects pending and slowdown responses before returning a session", async () => {
		const delays: number[] = [];
		let attempt = 0;
		const fetcher: typeof fetch = async () => {
			attempt += 1;
			if (attempt === 1) {
				return Response.json(
					{ error: "authorization_pending" },
					{ status: 400 },
				);
			}
			if (attempt === 2) {
				return Response.json({ error: "slow_down" }, { status: 400 });
			}
			return Response.json({
				access_token: ACCESS_TOKEN,
				refresh_token: "refresh-token",
				user: { id: "user_123", email: "dev@example.com" },
			});
		};

		const session = await pollDeviceAuthorization(
			"client_123",
			{
				deviceCode: "device-secret",
				userCode: "ABCD-EFGH",
				verificationUri: "https://auth.example/device",
				verificationUriComplete:
					"https://auth.example/device?user_code=ABCD-EFGH",
				expiresInSeconds: 300,
				intervalSeconds: 5,
			},
			{
				fetcher,
				sleep: async (milliseconds) => {
					delays.push(milliseconds);
				},
				now: () => 0,
			},
		);

		expect(delays).toEqual([5_000, 10_000]);
		expect(session.user.email).toBe("dev@example.com");
		expect(session.refreshToken).toBe("refresh-token");
	});

	it("fails immediately when the user denies authorization", async () => {
		const fetcher: typeof fetch = async () =>
			Response.json({ error: "access_denied" }, { status: 400 });

		await expect(
			pollDeviceAuthorization(
				"client_123",
				{
					deviceCode: "device-secret",
					userCode: "ABCD-EFGH",
					verificationUri: "https://auth.example/device",
					verificationUriComplete: "https://auth.example/device?user_code=x",
					expiresInSeconds: 300,
					intervalSeconds: 5,
				},
				{ fetcher, sleep: async () => {}, now: () => 0 },
			),
		).rejects.toThrow(/denied/u);
	});
});
