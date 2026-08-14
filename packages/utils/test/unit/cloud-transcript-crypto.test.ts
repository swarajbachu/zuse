import { describe, expect, test } from "vitest";

import {
	bytesToBase64Url,
	cloudTranscriptAdditionalData,
	decryptCloudTranscript,
	encryptCloudTranscript,
	sha256Base64Url,
} from "../../src/cloud-transcript-crypto.js";

describe("cloud transcript encryption", () => {
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
