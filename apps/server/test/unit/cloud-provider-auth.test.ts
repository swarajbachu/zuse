import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import {
	type CloudAuthProvider,
	type ProviderGrantRequest,
	SealedProviderGrant,
} from "@zuse/contracts";
import {
	type CryptoKey,
	calculateJwkThumbprint,
	exportJWK,
	generateKeyPair,
	type JWK,
} from "jose";
import { describe, expect, test } from "vitest";
import { CloudProviderAuth } from "../../src/api/cloud-provider-auth.ts";

const execAsync = promisify(exec);
const base64url = (value: Uint8Array): string =>
	Buffer.from(value).toString("base64url");

const seal = async (input: {
	readonly providerId: CloudAuthProvider;
	readonly request: ProviderGrantRequest;
	readonly publicKey: CryptoKey;
	readonly keyThumbprint: string;
	readonly workspaceId?: string;
}): Promise<SealedProviderGrant> => {
	const authorityIncarnationId = "authority-storage-1";
	const authorityEpoch = 3;
	const aad = new TextEncoder().encode(
		JSON.stringify({
			protocolVersion: 1,
			providerId: input.providerId,
			requestId: input.request.requestId,
			keyThumbprint: input.keyThumbprint,
			authorityIncarnationId,
			authorityEpoch,
		}),
	);
	const rawKey = randomBytes(32);
	const iv = randomBytes(12);
	const contentKey = await crypto.subtle.importKey(
		"raw",
		rawKey,
		{ name: "AES-GCM" },
		false,
		["encrypt"],
	);
	const now = Date.now();
	const plaintext = new TextEncoder().encode(
		JSON.stringify({
			zuseAccountId: "account-1",
			workspaceId: input.workspaceId ?? "workspace-1",
			runtimeGeneration: 4,
			keyThumbprint: input.keyThumbprint,
			authorityIncarnationId,
			authorityEpoch,
			providerId: input.providerId,
			method: "subscription",
			credentialKind: "oauth-token",
			secret: `${input.providerId}-access-only-token`,
			providerAccountId: `${input.providerId}-account-1`,
			issuer: input.providerId === "grok" ? "https://auth.x.ai" : null,
			issuedAt: now,
			expiresAt: now + 60 * 60_000,
		}),
	);
	const encrypted = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
			contentKey,
			plaintext,
		),
	);
	return new SealedProviderGrant({
		protocolVersion: 1,
		providerId: input.providerId,
		requestId: input.request.requestId,
		keyThumbprint: input.keyThumbprint,
		authorityIncarnationId,
		authorityEpoch,
		wrappedKey: base64url(
			new Uint8Array(
				await crypto.subtle.encrypt(
					{ name: "RSA-OAEP" },
					input.publicKey,
					rawKey,
				),
			),
		),
		iv: base64url(iv),
		ciphertext: base64url(encrypted.slice(0, -16)),
		tag: base64url(encrypted.slice(-16)),
	});
};

const fixture = async () => {
	const pair = await generateKeyPair("RSA-OAEP-256", { extractable: true });
	const publicJwk = await exportJWK(pair.publicKey);
	return {
		pair,
		credentialPublicJwk: JSON.stringify(publicJwk),
		keyThumbprint: await calculateJwkThumbprint(publicJwk as JWK),
	};
};

describe("CloudProviderAuth", () => {
	test("decrypts account grants and single-flights per provider", async () => {
		const { pair, credentialPublicJwk, keyThumbprint } = await fixture();
		let issueCount = 0;
		const auth = new CloudProviderAuth({
			zuseAccountId: "account-1",
			workspaceId: "workspace-1",
			runtimeGeneration: 4,
			credentialPublicJwk,
			credentialPrivateKey: pair.privateKey,
			issueGrant: async (providerId, request) => {
				issueCount += 1;
				await new Promise((resolve) => setTimeout(resolve, 10));
				return seal({
					providerId,
					request,
					publicKey: pair.publicKey,
					keyThumbprint,
				});
			},
		});

		const [left, right] = await Promise.all([
			auth.resolve("claude"),
			auth.resolve("claude"),
		]);
		expect(issueCount).toBe(1);
		expect(left).toEqual(right);
		expect(left).toMatchObject({
			kind: "oauth-token",
			secret: "claude-access-only-token",
		});
		auth.close();
	});

	test("serves Grok's official external-provider command without a refresh token", async () => {
		const { pair, credentialPublicJwk, keyThumbprint } = await fixture();
		const auth = new CloudProviderAuth({
			zuseAccountId: "account-1",
			workspaceId: "workspace-1",
			runtimeGeneration: 4,
			credentialPublicJwk,
			credentialPrivateKey: pair.privateKey,
			issueGrant: (providerId, request) =>
				seal({
					providerId,
					request,
					publicKey: pair.publicKey,
					keyThumbprint,
				}),
		});
		await auth.startGrokBridge();
		const command = process.env.GROK_AUTH_PROVIDER_COMMAND;
		expect(command).toBeTypeOf("string");
		expect(process.env.GROK_AUTH_PATH).toMatch(
			/^\/dev\/shm\/zuse-provider-auth-\d+\/grok-auth\.json$/u,
		);
		const { stdout } = await execAsync(command as string, {
			env: { ...process.env, GROK_AUTH_EXPIRED: "0" },
		});
		const response = JSON.parse(stdout) as Record<string, unknown>;
		expect(response.access_token).toBe("grok-access-only-token");
		expect(response.expires_in).toBeTypeOf("number");
		expect(response.issuer).toBe("https://auth.x.ai");
		expect(response).not.toHaveProperty("refresh_token");
		auth.close();
	});

	test("rejects a grant sealed for another workspace", async () => {
		const { pair, credentialPublicJwk, keyThumbprint } = await fixture();
		const auth = new CloudProviderAuth({
			zuseAccountId: "account-1",
			workspaceId: "workspace-1",
			runtimeGeneration: 4,
			credentialPublicJwk,
			credentialPrivateKey: pair.privateKey,
			issueGrant: (providerId, request) =>
				seal({
					providerId,
					request,
					publicKey: pair.publicKey,
					keyThumbprint,
					workspaceId: "workspace-2",
				}),
		});

		await expect(auth.resolve("claude")).rejects.toThrow(
			"claude-auth-update-required",
		);
		auth.close();
	});
});
