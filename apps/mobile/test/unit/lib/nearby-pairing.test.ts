import { describe, expect, test } from "vitest";

import {
	deriveSafetyPhrase,
	serverKeyPin,
} from "../../../src/lib/nearby-pairing";

describe("nearby pairing transcript", () => {
	test("derives the same user-facing phrase as the Mac", () => {
		expect(
			deriveSafetyPhrase({
				deviceId: "mobile_1",
				devicePublicKey: "phone-key",
				ephemeralPublicKey: "ephemeral-key",
				clientNonce: "client-nonce",
				serverNonce: "server-nonce",
				environmentPublicKey: '{"kty":"OKP"}',
			}),
		).toBe("kite-harbor-apple");
	});

	test("pins the exact environment public key", () => {
		expect(serverKeyPin('{"kty":"OKP"}')).toBe(
			"sha256/Of9FaZT-fZrZfNc8s9SexlJPCO1HH4ZWHq7EJJwroug",
		);
	});
});
