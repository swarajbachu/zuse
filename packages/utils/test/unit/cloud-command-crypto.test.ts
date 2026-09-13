import { describe, expect, test } from "vitest";
import {
	cloudCommandAdditionalData,
	decryptCloudCommandBody,
	encryptCloudCommandBody,
	keyedCloudCommandFingerprint,
} from "../../src/cloud-command-crypto.js";
import { bytesToBase64Url } from "../../src/cloud-transcript-crypto.js";

describe("cloud command crypto", () => {
	test("authenticates routing metadata and computes a keyed fingerprint", async () => {
		const encodedKey = bytesToBase64Url(
			crypto.getRandomValues(new Uint8Array(32)),
		);
		const plaintext = new TextEncoder().encode('{"text":"wake me"}');
		const metadata = {
			workspaceId: "workspace-1",
			sessionId: "session-1",
			commandId: "command-1",
			kind: "messages.send",
			fingerprint: await keyedCloudCommandFingerprint({
				encodedKey,
				canonicalPlaintext: plaintext,
			}),
			schemaVersion: 1,
			keyVersion: 1,
			destructionFence: 0,
			createdAt: 1,
			dependencies: [],
		};
		const additionalData = cloudCommandAdditionalData(metadata);
		const encrypted = await encryptCloudCommandBody({
			encodedKey,
			additionalData,
			plaintext,
		});
		expect(
			new TextDecoder().decode(
				await decryptCloudCommandBody({
					encodedKey,
					additionalData,
					...encrypted,
				}),
			),
		).toBe('{"text":"wake me"}');
		await expect(
			decryptCloudCommandBody({
				encodedKey,
				additionalData: cloudCommandAdditionalData({
					...metadata,
					sessionId: "other-session",
				}),
				...encrypted,
			}),
		).rejects.toBeDefined();
	});
});
