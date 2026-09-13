import { afterEach, describe, expect, test, vi } from "vitest";

import {
	bytesToBase64Url,
	cloudTranscriptAdditionalData,
	decryptCloudTranscript,
	encryptCloudTranscript,
	sha256Base64Url,
} from "../../src/cloud-transcript-crypto.js";

describe("cloud transcript encryption", () => {
	afterEach(() => vi.unstubAllGlobals());
	test("decrypts browser gzip checkpoints without native compression streams", async () => {
		const encodedKey = bytesToBase64Url(new Uint8Array(32).fill(7));
		const additionalData = new TextEncoder().encode(
			"qualified workspace/session/cursor",
		);
		const plaintext = new TextEncoder().encode(
			"Cloud history on Hermes. ".repeat(500),
		);
		const ciphertext = await encryptCloudTranscript({
			encodedKey,
			additionalData,
			plaintext,
		});
		vi.stubGlobal("DecompressionStream", undefined);
		expect(
			await decryptCloudTranscript({ encodedKey, additionalData, ciphertext }),
		).toEqual(plaintext);
		await expect(
			decryptCloudTranscript({
				encodedKey,
				additionalData: new Uint8Array([0]),
				ciphertext,
			}),
		).rejects.toThrow();
	});
	test("portable gzip output is readable by the browser decoder", async () => {
		const encodedKey = bytesToBase64Url(new Uint8Array(32).fill(7));
		const additionalData = new Uint8Array([1, 2, 3]);
		const plaintext = new TextEncoder().encode("portable wire format");
		vi.stubGlobal("CompressionStream", undefined);
		const ciphertext = await encryptCloudTranscript({
			encodedKey,
			additionalData,
			plaintext,
		});
		vi.unstubAllGlobals();
		expect(
			await decryptCloudTranscript({ encodedKey, additionalData, ciphertext }),
		).toEqual(plaintext);
	});
	test("round trips compressed projections and authenticates cursor metadata", async () => {
		const encodedKey = bytesToBase64Url(
			crypto.getRandomValues(new Uint8Array(32)),
		);
		const plaintext = new TextEncoder().encode(
			JSON.stringify({ messages: ["durable output ".repeat(2_000)] }),
		);
		const additionalData = cloudTranscriptAdditionalData({
			workspaceId: "workspace-1",
			sessionId: "session-1",
			epoch: "epoch-1",
			version: 42,
			schemaVersion: 1,
		});
		const ciphertext = await encryptCloudTranscript({
			encodedKey,
			additionalData,
			plaintext,
		});

		expect(
			new TextDecoder().decode(
				await decryptCloudTranscript({
					encodedKey,
					additionalData,
					ciphertext,
				}),
			),
		).toBe(new TextDecoder().decode(plaintext));
		expect(await sha256Base64Url(ciphertext)).toHaveLength(43);
		await expect(
			decryptCloudTranscript({
				encodedKey,
				additionalData: cloudTranscriptAdditionalData({
					workspaceId: "workspace-1",
					sessionId: "session-1",
					epoch: "epoch-1",
					version: 41,
					schemaVersion: 1,
				}),
				ciphertext,
			}),
		).rejects.toThrow();
	});
});
