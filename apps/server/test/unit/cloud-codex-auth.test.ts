import { randomBytes } from "node:crypto";
import { type CodexGrantRequest, SealedCodexGrant } from "@zuse/contracts";
import {
	type CryptoKey,
	calculateJwkThumbprint,
	exportJWK,
	generateKeyPair,
	type JWK,
} from "jose";
import { describe, expect, test } from "vitest";
import { CloudCodexAuth } from "../../src/api/cloud-codex-auth.ts";

const base64url = (value: Uint8Array): string =>
	Buffer.from(value).toString("base64url");

const seal = async (input: {
	readonly request: CodexGrantRequest;
	readonly publicKey: CryptoKey;
	readonly keyThumbprint: string;
	readonly workspaceId?: string;
	readonly credential?: Record<string, unknown>;
}): Promise<SealedCodexGrant> => {
	const authorityIncarnationId = "authority-storage-1";
	const authorityEpoch = 3;
	const aad = new TextEncoder().encode(
		JSON.stringify({
			protocolVersion: 1,
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
	const plaintext = new TextEncoder().encode(
		JSON.stringify({
			zuseAccountId: "account-1",
			workspaceId: input.workspaceId ?? "workspace-1",
			runtimeGeneration: 4,
			keyThumbprint: input.keyThumbprint,
			authorityIncarnationId,
			authorityEpoch,
			...(input.credential ?? {
				chatgptAccountId: "chatgpt-account-1",
				chatgptPlanType: "pro",
				accessToken: "access-only-token",
			}),
			issuedAt: Date.now(),
			expiresAt: Date.now() + 60 * 60_000,
		}),
	);
	const encrypted = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
			contentKey,
			plaintext,
		),
	);
	return new SealedCodexGrant({
		protocolVersion: 1,
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
	const credentialPublicJwk = JSON.stringify(publicJwk);
	const keyThumbprint = await calculateJwkThumbprint(publicJwk as JWK);
	return { pair, credentialPublicJwk, keyThumbprint };
};

describe("CloudCodexAuth", () => {
	test("decrypts fenced grants and single-flights concurrent refreshes", async () => {
		const { pair, credentialPublicJwk, keyThumbprint } = await fixture();
		let issueCount = 0;
		const recoveredConsumers: ReadonlyArray<string>[] = [];
		const auth = new CloudCodexAuth({
			zuseAccountId: "account-1",
			workspaceId: "workspace-1",
			runtimeGeneration: 4,
			credentialPublicJwk,
			credentialPrivateKey: pair.privateKey,
			issueGrant: async (request) => {
				issueCount += 1;
				await new Promise((resolve) => setTimeout(resolve, 10));
				return seal({ request, publicKey: pair.publicKey, keyThumbprint });
			},
			onConsumersRecovered: (consumerIds) =>
				recoveredConsumers.push(consumerIds),
		});
		auth.onDeliveryFailure({
			consumerId: "session-1",
			reason: "codex-auth-reconnect-required",
		});

		const [left, right] = await Promise.all([
			auth.getTokens({ reason: "unauthorized" }),
			auth.getTokens({ reason: "unauthorized" }),
		]);

		expect(issueCount).toBe(1);
		expect(left).toEqual(right);
		expect(left).toMatchObject({
			accessToken: "access-only-token",
			chatgptAccountId: "chatgpt-account-1",
			chatgptPlanType: "pro",
		});
		expect(recoveredConsumers).toEqual([["session-1"]]);
		auth.close();
	});

	test("rejects a grant sealed for another workspace", async () => {
		const { pair, credentialPublicJwk, keyThumbprint } = await fixture();
		const auth = new CloudCodexAuth({
			zuseAccountId: "account-1",
			workspaceId: "workspace-1",
			runtimeGeneration: 4,
			credentialPublicJwk,
			credentialPrivateKey: pair.privateKey,
			issueGrant: (request) =>
				seal({
					request,
					publicKey: pair.publicKey,
					keyThumbprint,
					workspaceId: "workspace-2",
				}),
		});

		await expect(auth.initialize()).rejects.toThrow(
			"codex-auth-update-required",
		);
		auth.close();
	});

	test("preserves typed control-plane reconnect status", async () => {
		const { pair, credentialPublicJwk } = await fixture();
		const statuses: string[] = [];
		const failure = { reason: "codex-auth-reconnect-required" };
		const auth = new CloudCodexAuth({
			zuseAccountId: "account-1",
			workspaceId: "workspace-1",
			runtimeGeneration: 4,
			credentialPublicJwk,
			credentialPrivateKey: pair.privateKey,
			issueGrant: async () => Promise.reject(failure),
			onStatus: (status) => statuses.push(status),
		});

		await expect(auth.initialize()).rejects.toBe(failure);
		expect(statuses).toEqual([
			"codex-auth-reconnecting",
			"codex-auth-reconnect-required",
		]);
		auth.close();
	});

	test("advertises API-key support and decodes a brokered account API key", async () => {
		const { pair, credentialPublicJwk, keyThumbprint } = await fixture();
		const requests: CodexGrantRequest[] = [];
		const auth = new CloudCodexAuth({
			zuseAccountId: "account-1",
			workspaceId: "workspace-1",
			runtimeGeneration: 4,
			credentialPublicJwk,
			credentialPrivateKey: pair.privateKey,
			issueGrant: (request) => {
				requests.push(request);
				return seal({
					request,
					publicKey: pair.publicKey,
					keyThumbprint,
					credential: { credentialKind: "api-key", apiKey: "sk-account-key" },
				});
			},
		});

		await expect(auth.getTokens({ reason: "initial" })).resolves.toMatchObject({
			kind: "api-key",
			apiKey: "sk-account-key",
		});
		expect(requests[0]?.acceptsApiKey).toBe(true);
		// A ChatGPT session asking to refresh its account cannot adopt a key.
		await expect(
			auth.getTokens({
				reason: "unauthorized",
				previousChatgptAccountId: "chatgpt-account-1",
			}),
		).rejects.toThrow("codex-auth-reconnect-required");
		auth.close();
	});

	test("labels legacy and explicit ChatGPT grants identically", async () => {
		const { pair, credentialPublicJwk, keyThumbprint } = await fixture();
		for (const credential of [
			undefined,
			{
				credentialKind: "chatgpt",
				chatgptAccountId: "chatgpt-account-1",
				chatgptPlanType: null,
				accessToken: "access-only-token",
			},
		]) {
			const auth = new CloudCodexAuth({
				zuseAccountId: "account-1",
				workspaceId: "workspace-1",
				runtimeGeneration: 4,
				credentialPublicJwk,
				credentialPrivateKey: pair.privateKey,
				issueGrant: (request) =>
					seal({
						request,
						publicKey: pair.publicKey,
						keyThumbprint,
						...(credential === undefined ? {} : { credential }),
					}),
			});
			await expect(
				auth.getTokens({ reason: "initial" }),
			).resolves.toMatchObject({
				kind: "chatgpt",
				accessToken: "access-only-token",
				chatgptAccountId: "chatgpt-account-1",
			});
			auth.close();
		}
	});

	test("rejects an API-key grant that carries no key", async () => {
		const { pair, credentialPublicJwk, keyThumbprint } = await fixture();
		const auth = new CloudCodexAuth({
			zuseAccountId: "account-1",
			workspaceId: "workspace-1",
			runtimeGeneration: 4,
			credentialPublicJwk,
			credentialPrivateKey: pair.privateKey,
			issueGrant: (request) =>
				seal({
					request,
					publicKey: pair.publicKey,
					keyThumbprint,
					credential: { credentialKind: "api-key" },
				}),
		});
		await expect(auth.initialize()).rejects.toThrow(
			"codex-auth-update-required",
		);
		auth.close();
	});
});
