import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
	CloudAccountImage,
	CloudAuthConfigureRequest,
	CloudAuthProviderStatus,
	CloudAuthStatus,
	CodexGrantRequest,
	SealedCodexGrant,
} from "../../src/index.ts";

describe("E2B cloud authentication contracts", () => {
	it("models one account image generation with redacted provider readiness", () => {
		const image = Schema.decodeUnknownSync(CloudAccountImage)({
			state: "ready",
			generation: "image-2",
			providerId: "e2b",
			runtimeVersion: "runtime-2",
			repositories: [
				{
					projectId: "project-1",
					repositoryIdentity: "github.com/acme/app",
					displayName: "app",
					defaultBranch: "main",
				},
			],
			providers: [
				{
					providerId: "codex",
					state: "connected",
					method: "subscription",
					verifiedAt: 100,
				},
			],
			builds: [],
			builtAt: 100,
			updatedAt: 100,
		});

		expect(image.generation).toBe("image-2");
		expect(JSON.stringify(image)).not.toContain("secret");
	});

	it("keeps authority lifecycle separate from provider authentication", () => {
		const status = Schema.decodeUnknownSync(CloudAuthStatus)({
			authorityState: "ready",
			encryptionKeyId: "authority-key-1",
			encryptionPublicJwk: '{"kty":"RSA"}',
			providers: [
				{
					providerId: "codex",
					state: "unsupported-for-sandbox",
					method: "subscription",
				},
			],
		});

		expect(status.authorityState).toBe("ready");
		expect(status.providers[0]?.state).toBe("unsupported-for-sandbox");
	});

	it("accepts only a sealed secret for credential setup", () => {
		const request = Schema.decodeUnknownSync(CloudAuthConfigureRequest)({
			providerId: "claude",
			method: "subscription",
			sealedSecret: {
				keyId: "authority-key-1",
				ciphertext: "encrypted-for-authority",
			},
		});

		expect(request.sealedSecret.ciphertext).toBe("encrypted-for-authority");
		expect("secret" in request).toBe(false);
		expect(() =>
			Schema.decodeUnknownSync(CloudAuthConfigureRequest)({
				providerId: "claude",
				method: "subscription",
				secret: "plaintext-must-not-be-accepted",
			}),
		).toThrow();
	});

	it("does not expose provider secrets in public status", () => {
		const provider = Schema.decodeUnknownSync(CloudAuthProviderStatus)({
			providerId: "grok",
			state: "connected",
			method: "api-key",
			accountLabel: "xAI account",
			verifiedAt: 1_787_163_600_000,
		});

		expect(provider.accountLabel).toBe("xAI account");
		expect("secret" in provider).toBe(false);
	});

	it("routes only fenced Codex grant ciphertext through the API", () => {
		const request = Schema.decodeUnknownSync(CodexGrantRequest)({
			requestId: "4d2e6635-0f48-4aca-9d58-9942f08b1659",
			protocolVersion: 1,
			runtimeGeneration: 4,
			credentialPublicJwk: '{"kty":"RSA"}',
			reason: "initial",
		});
		const sealed = Schema.decodeUnknownSync(SealedCodexGrant)({
			protocolVersion: 1,
			requestId: request.requestId,
			keyThumbprint: "runtime-key",
			authorityIncarnationId: "authority-storage",
			authorityEpoch: 2,
			wrappedKey: "wrapped",
			iv: "nonce",
			ciphertext: "opaque",
			tag: "authenticated",
		});

		expect(JSON.stringify(sealed)).not.toMatch(
			/accessToken|refreshToken|chatgptAccountId/,
		);
		expect(request.reason).toBe("initial");
	});
});
