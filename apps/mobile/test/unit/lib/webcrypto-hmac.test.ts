import { createHmac } from "node:crypto";
import { keyedCloudCommandFingerprint } from "@zuse/utils/cloud-command-crypto";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("react-native-quick-crypto", () => ({
	default: {
		createHmac: (algorithm: string, key: Uint8Array) =>
			createHmac(algorithm, key),
	},
}));

const { installWebCryptoHmac } = await import(
	"../../../src/lib/webcrypto-hmac"
);

const original = globalThis.crypto;
afterEach(() => {
	Object.defineProperty(globalThis, "crypto", {
		value: original,
		configurable: true,
	});
});

test("signs HMAC where quick-crypto's subtle.sign rejects it", async () => {
	// react-native-quick-crypto 0.7: HMAC keys import, but sign() throws.
	const subtle = {
		importKey: async (
			_format: string,
			_data: unknown,
			algorithm: { name: string; hash: string },
		) => ({
			type: "secret",
			algorithm: { name: algorithm.name, hash: { name: algorithm.hash } },
		}),
		sign: async () => {
			throw new Error("Unrecognized algorithm name");
		},
		verify: async () => {
			throw new Error("Unrecognized algorithm name");
		},
	};
	Object.defineProperty(globalThis, "crypto", {
		value: { subtle, getRandomValues: original.getRandomValues },
		configurable: true,
	});
	installWebCryptoHmac();

	const key = Buffer.alloc(32, 7);
	const plaintext = new TextEncoder().encode('{"text":"Does this work?"}');
	const fingerprint = await keyedCloudCommandFingerprint({
		encodedKey: key.toString("base64url"),
		canonicalPlaintext: plaintext,
	});
	expect(fingerprint).toBe(
		`hmac-sha256:${createHmac("sha256", key).update(plaintext).digest("base64url")}`,
	);
});
