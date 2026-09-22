import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { describe, expect, test, vi } from "vitest";

import {
	acceptedWorkosIssuers,
	expectedWorkosClientId,
	isAcceptedWorkosIssuer,
	workosVerificationKeys,
} from "../../src/workos.ts";

describe("acceptedWorkosIssuers", () => {
	test("accepts WorkOS issuer with and without trailing slash", () => {
		expect(acceptedWorkosIssuers("https://api.workos.com")).toEqual([
			"https://api.workos.com",
			"https://api.workos.com/",
		]);
		expect(acceptedWorkosIssuers("https://api.workos.com/")).toEqual([
			"https://api.workos.com",
			"https://api.workos.com/",
		]);
	});

	test("accepts WorkOS User Management token issuers", () => {
		expect(
			isAcceptedWorkosIssuer(
				"https://api.workos.com/user_management/client_01KW6ZF0389TC20FTQHK4VP8KA",
				"https://api.workos.com",
			),
		).toBe(true);
		expect(
			isAcceptedWorkosIssuer(
				"https://example.test/user_management/client_01KW6ZF0389TC20FTQHK4VP8KA",
				"https://api.workos.com",
			),
		).toBe(false);
	});

	test("extracts expected client id from WorkOS JWKS URL", () => {
		expect(
			expectedWorkosClientId(
				"https://api.workos.com/sso/jwks/client_01KWGQ818571ARFATQ3G9AR2Y2",
			),
		).toBe("client_01KWGQ818571ARFATQ3G9AR2Y2");
	});
});

test("request-scoped verifiers reuse public keys while preserving rotation and expiry checks", async () => {
	const first = await generateKeyPair("ES256");
	const second = await generateKeyPair("ES256");
	let keys = [{ ...(await exportJWK(first.publicKey)), kid: "first" }];
	const fetchKeys = vi.fn(async () => Response.json({ keys }));
	vi.stubGlobal("fetch", fetchKeys);
	vi.useFakeTimers({ toFake: ["Date"] });
	const url = `https://keys.example.test/${crypto.randomUUID()}`;
	const issue = (key: CryptoKey, kid: string, expires: string) =>
		new SignJWT({})
			.setProtectedHeader({ alg: "ES256", kid })
			.setIssuer("test")
			.setExpirationTime(expires)
			.sign(key);
	try {
		const token = await issue(first.privateKey, "first", "5m");
		await jwtVerify(token, workosVerificationKeys(url), { issuer: "test" });
		await jwtVerify(token, workosVerificationKeys(url), { issuer: "test" });
		expect(fetchKeys).toHaveBeenCalledTimes(1);
		await expect(
			jwtVerify(token, workosVerificationKeys(url), { issuer: "wrong" }),
		).rejects.toThrow();
		await expect(
			jwtVerify(
				await issue(first.privateKey, "first", "-1s"),
				workosVerificationKeys(url),
			),
		).rejects.toThrow();
		keys = [{ ...(await exportJWK(second.publicKey)), kid: "second" }];
		vi.setSystemTime(Date.now() + 31_000);
		const rotated = await issue(second.privateKey, "second", "30m");
		await jwtVerify(rotated, workosVerificationKeys(url));
		expect(fetchKeys).toHaveBeenCalledTimes(2);
		vi.setSystemTime(Date.now() + 601_000);
		await jwtVerify(rotated, workosVerificationKeys(url));
		expect(fetchKeys).toHaveBeenCalledTimes(3);
	} finally {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	}
});
