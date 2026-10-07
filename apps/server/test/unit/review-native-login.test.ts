import { describe, expect, it } from "vitest";
import {
	parseNativeLoginChallenge,
	validateNativeLoginCallback,
} from "../../src/review/native-login.ts";

const redirect = "http://localhost:12345/callback";
const authorization = `https://claude.ai/oauth/authorize?redirect_uri=${encodeURIComponent(redirect)}&state=challenge-state`;
const challenge = {
	authorizationUrl: authorization,
	redirectUri: redirect,
	state: "challenge-state",
	expiresAtMs: 2000,
};
describe("native login callback relay", () => {
	it("extracts only recognized provider OAuth with loopback redirect", () => {
		expect(parseNativeLoginChallenge(`Open ${authorization}\n`, 2000)).toEqual(
			challenge,
		);
	});
	it.each([
		"https://evil.example/oauth",
		"https://claude.ai/oauth?redirect_uri=http://169.254.169.254/latest&state=x",
		"https://claude.ai/oauth?redirect_uri=http://localhost/callback&state=x",
	])("rejects unrelated/malformed challenge %s", (url) => {
		expect(parseNativeLoginChallenge(url, 2000)).toBeNull();
	});
	it("accepts exact one-use callback target and state", () => {
		expect(
			validateNativeLoginCallback(
				challenge,
				`${redirect}?code=opaque&state=challenge-state`,
				1000,
			).origin,
		).toBe("http://localhost:12345");
	});
	it.each([
		"http://127.0.0.1:12345/callback?code=x&state=challenge-state",
		"http://localhost:12346/callback?code=x&state=challenge-state",
		"http://localhost:12345/other?code=x&state=challenge-state",
		`${redirect}?code=x&state=wrong`,
		`${redirect}?code=x&state=challenge-state&state=challenge-state`,
		`${redirect}?code=x&state=challenge-state&next=https://evil.example`,
		`${redirect}?code=x&state=challenge-state#fragment`,
	])("rejects callback substitution %s", (url) => {
		expect(() => validateNativeLoginCallback(challenge, url, 1000)).toThrow();
	});
	it("rejects expired challenge", () => {
		expect(() =>
			validateNativeLoginCallback(
				challenge,
				`${redirect}?code=x&state=challenge-state`,
				2000,
			),
		).toThrow();
	});
});
