import { BillingProvidersManual } from "@zuse/billing-providers";
import { ApiPaths } from "@zuse/contracts";
import { MachineProvidersFake } from "@zuse/machine-providers/testing";
import { SandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, test } from "vitest";
import {
	AccountIdentity,
	type AccountIdentityApi,
} from "../../src/account-identity.ts";
import { BetaAccessAllowAll } from "../../src/beta-access.ts";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";
import {
	CloudWorkspaceLaunchIntentCipher,
	CloudWorkspaceLaunchIntentCipherLive,
} from "../../src/cloud-workspace-launch-intent.ts";
import {
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import { layer as configurationLayer } from "../../src/config.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { handleRequest } from "../../src/handler.ts";
import { MachineControlConfiguration } from "../../src/machine-config.ts";
import { MachineStoreMemory } from "../../src/machine-store.ts";
import { ManagedTunnelProviderLive } from "../../src/managed-tunnel.ts";
import { PushDelivery } from "../../src/push.ts";
import { SandboxOfferConfiguration } from "../../src/sandbox-provider-module.ts";
import { ApiStoreMemory } from "../../src/store.ts";
import { WorkosVerifierTest } from "../../src/workos.ts";

const ISSUER = "https://api.test";

const makeRuntime = async () => {
	const mint = await generateKeyPair("EdDSA", { extractable: true });
	const config = configurationLayer({
		apiIssuer: ISSUER,
		workosJwksUrl: "https://unused.test/jwks",
		workosIssuer: "https://unused.test",
		mintPrivateKey: Redacted.make(
			JSON.stringify(await exportJWK(mint.privateKey)),
		),
		mintPublicKey: JSON.stringify(await exportJWK(mint.publicKey)),
		cloudDataEncryptionKey: Redacted.make(
			"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		),
	});
	const layer = Layer.mergeAll(
		config,
		BetaAccessAllowAll,
		WorkosVerifierTest,
		ApiStoreMemory,
		CloudWorkspaceStoreMemory,
		CloudBillingStoreMemory,
		MachineStoreMemory,
		MachineProvidersFake,
		BillingProvidersManual,
		SandboxProvidersFake,
		Layer.effect(
			CloudWorkspaceLaunchIntentCipher,
			CloudWorkspaceLaunchIntentCipherLive,
		).pipe(Layer.provide(config), Layer.orDie),
		Layer.succeed(SandboxOfferConfiguration, {
			port: 47_837,
			vcpuCount: 2,
			memoryMib: 1_024,
			createTimeoutSeconds: 86_400,
			keepAliveTimeoutSeconds: 86_400,
		}),
		Layer.succeed(MachineControlConfiguration, {
			allowlistedAccountIds: new Set<string>(),
			manualEntitlementsEnabled: false,
			liveCheckoutEnabled: false,
			enrollmentTtlMs: 30 * 60 * 1_000,
			recoveryWindowMs: 7 * 24 * 60 * 60 * 1_000,
			finalSnapshotRetentionMs: 14 * 24 * 60 * 60 * 1_000,
			reconcileLeaseMs: 5 * 60 * 1_000,
		}),
		ManagedTunnelProviderLive.pipe(Layer.provide(config)),
		Layer.succeed(PushDelivery, PushDelivery.of({ send: () => Effect.void })),
		Layer.succeed(
			AccountIdentity,
			AccountIdentity.of({
				deleteUser: () => Effect.void,
				verifiedEmail: () => Effect.succeed(null),
			} satisfies AccountIdentityApi),
		),
	);
	return ManagedRuntime.make(layer);
};

describe("cloud workspace runtime bootstrap", () => {
	test("backfills transcript keys and replays a byte-stable bootstrap", async () => {
		const runtime = await makeRuntime();
		const store = await runtime.runPromise(CloudWorkspaceStore);
		const now = Date.now();
		const workspaceId = "workspace-bootstrap";
		const bootTokenHash = await runtime.runPromise(sha256Hex("boot-token"));
		const launchCiphertext = await runtime.runPromise(
			Effect.gen(function* () {
				const cipher = yield* CloudWorkspaceLaunchIntentCipher;
				return yield* cipher.encrypt("account-1", workspaceId, {
					commandId: "launch-1",
					turnId: "turn-1",
					title: "Durable launch",
					agent: "codex",
					model: "gpt-5",
					permissions: [],
					firstMessage: "continue while disconnected",
				});
			}),
		);
		await runtime.runPromise(
			store.createWorkspace(
				{
					workspaceId,
					accountId: "account-1",
					projectId: "project-1",
					buildId: "build-1",
					provider: "fake",
					providerSandboxId: "fake-sandbox",
					runtimeBootTokenHash: bootTokenHash,
					runtimeBootTokenExpiresAtMs: now + 60_000,
					runtimeState: "offline",
					chatId: "chat-1",
					initialSessionId: "session-1",
					branch: "task/bootstrap",
					baseRef: "origin/main",
					state: "provisioning",
					desiredState: "ready",
					statusCode: "runtime-starting",
					idempotencyKey: "bootstrap-key",
					requestConfig: {
						runtimeGeneration: 4,
						gatewayEpoch: 8,
					},
					nextActionAtMs: now + 30_000,
					revision: 1,
					createdAtMs: now,
					updatedAtMs: now,
					lastActivityAtMs: now,
				},
				{
					workspaceId,
					accountId: "account-1",
					chatId: "chat-1",
					sessionId: "session-1",
					turnId: "turn-1",
					commandId: "launch-1",
					ciphertext: launchCiphertext,
					expiresAtMs: now + 60_000,
					createdAtMs: now,
				},
			),
		);

		const ticketResponse = await runtime.runPromise(
			handleRequest(
				new Request(
					`${ISSUER}${ApiPaths.cloudWorkspaceConnectionTicket(workspaceId)}`,
					{
						method: "POST",
						headers: {
							authorization: "Bearer test-token:account-1",
							"x-zuse-device-id": "desktop-1",
						},
					},
				),
			),
		);
		expect(ticketResponse.status).toBe(200);
		expect(await ticketResponse.json()).toMatchObject({
			workspaceId,
			protocol: "zuse-workspace-v2",
			role: "client",
			generation: 4,
			gatewayEpoch: 8,
		});

		const credentialKey = await generateKeyPair("RSA-OAEP-256", {
			extractable: true,
		});
		const signingKey = await generateKeyPair("EdDSA", { extractable: true });
		const body = {
			credentialPublicJwk: JSON.stringify(
				await exportJWK(credentialKey.publicKey),
			),
			signingPublicJwk: JSON.stringify(await exportJWK(signingKey.publicKey)),
		};
		const bootstrap = (requestBody = body) =>
			runtime.runPromise(
				handleRequest(
					new Request(
						`${ISSUER}${ApiPaths.cloudWorkspaceBootstrap(workspaceId)}`,
						{
							method: "POST",
							headers: {
								authorization: "Bearer boot-token",
								"content-type": "application/json",
							},
							body: JSON.stringify(requestBody),
						},
					),
				),
			);
		const firstResponse = await bootstrap();
		expect(firstResponse.status).toBe(200);
		expect(
			await runtime.runPromise(store.getWorkspace(workspaceId)),
		).toMatchObject({ wrappedTranscriptKey: expect.any(String) });
		const first = (await firstResponse.json()) as Record<string, unknown>;
		expect(first.cloudCredentials).toEqual([]);
		const replayResponse = await bootstrap();
		expect(replayResponse.status).toBe(200);
		expect(await replayResponse.json()).toEqual(first);
		expect(first.launchIntent).toMatchObject({ commandId: "launch-1" });

		const changedSigningKey = await generateKeyPair("EdDSA", {
			extractable: true,
		});
		expect(
			(
				await bootstrap({
					...body,
					signingPublicJwk: JSON.stringify(
						await exportJWK(changedSigningKey.publicKey),
					),
				})
			).status,
		).toBe(401);
		const changedCredentialKey = await generateKeyPair("RSA-OAEP-256", {
			extractable: true,
		});
		expect(
			(
				await bootstrap({
					...body,
					credentialPublicJwk: JSON.stringify(
						await exportJWK(changedCredentialKey.publicKey),
					),
				})
			).status,
		).toBe(401);
		const credential = String(first.runtimeCredential);
		const wrongFenceAck = await runtime.runPromise(
			handleRequest(
				new Request(
					`${ISSUER}${ApiPaths.cloudWorkspaceBootstrapAck(workspaceId)}`,
					{
						method: "POST",
						headers: {
							authorization: `Bearer ${credential}`,
							"content-type": "application/json",
						},
						body: JSON.stringify({ runtimeGeneration: 5, gatewayEpoch: 8 }),
					},
				),
			),
		);
		expect(wrongFenceAck.status).toBe(401);
		expect(
			await runtime.runPromise(store.getWorkspace(workspaceId)),
		).toMatchObject({ runtimeBootTokenHash: bootTokenHash });

		const ack = () =>
			runtime.runPromise(
				handleRequest(
					new Request(
						`${ISSUER}${ApiPaths.cloudWorkspaceBootstrapAck(workspaceId)}`,
						{
							method: "POST",
							headers: {
								authorization: `Bearer ${credential}`,
								"content-type": "application/json",
							},
							body: JSON.stringify({ runtimeGeneration: 4, gatewayEpoch: 8 }),
						},
					),
				),
			);
		expect((await ack()).status).toBe(200);
		expect((await ack()).status).toBe(200);
		expect((await bootstrap()).status).toBe(401);
		expect(
			await runtime.runPromise(store.getLaunchIntent(workspaceId, now + 1)),
		).toMatchObject({ commandId: "launch-1" });
		await runtime.dispose();
	});
});
