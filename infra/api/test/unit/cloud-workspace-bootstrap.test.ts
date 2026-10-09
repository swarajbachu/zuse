import { BillingProvidersManual } from "@zuse/billing-providers";
import {
	ApiPaths,
	CLOUD_RUNTIME_GITHUB_EXECUTION_CAPABILITY,
	CLOUD_RUNTIME_WORKSPACE_AUTHORIZATION_CAPABILITY,
} from "@zuse/contracts";
import { MachineProvidersFake } from "@zuse/machine-providers/testing";
import {
	makeSandboxProviders,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { SandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT } from "jose";
import { describe, expect, test, vi } from "vitest";
import {
	AccountIdentity,
	type AccountIdentityApi,
} from "../../src/account-identity.ts";
import { encodeApiMessageContent } from "../../src/api-message-content.ts";
import { apiMessageSealContext, sealApiString } from "../../src/api-sealing.ts";
import { CloudBillingStore } from "../../src/cloud-billing-store.ts";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";
import { takeCloudMailboxDirective } from "../../src/cloud-mailbox-directive.ts";
import {
	CloudProviderConnections,
	type ProviderConnectionRecord,
} from "../../src/cloud-provider-connections.ts";
import {
	CloudWorkspaceLaunchIntentCipher,
	CloudWorkspaceLaunchIntentCipherLive,
} from "../../src/cloud-workspace-launch-intent.ts";
import {
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import {
	ApiConfiguration,
	layer as configurationLayer,
} from "../../src/config.ts";
import {
	parseJwk,
	runtimeSigningKeyThumbprint,
	sha256Hex,
	signWorkspaceClientTicket,
} from "../../src/crypto.ts";
import { handleRequest } from "../../src/handler.ts";
import { MachineControlConfiguration } from "../../src/machine-config.ts";
import { MachineStore, MachineStoreMemory } from "../../src/machine-store.ts";
import { ManagedTunnelProviderLive } from "../../src/managed-tunnel.ts";
import { PushDelivery } from "../../src/push.ts";
import { SandboxOfferConfiguration } from "../../src/sandbox-provider-module.ts";
import { ApiStoreMemory } from "../../src/store.ts";
import { WorkosVerifierTest } from "../../src/workos.ts";

const ISSUER = "https://api.test";

const makeRuntime = async (organizationWorkspacesEnabled = false) => {
	const mint = await generateKeyPair("EdDSA", { extractable: true });
	const config = configurationLayer({
		githubApp: {
			appId: "app",
			slug: "zuse",
			clientId: "client",
			clientSecret: Redacted.make("secret"),
			privateKey: Redacted.make(
				await exportPKCS8(
					(await generateKeyPair("RS256", { extractable: true })).privateKey,
				),
			),
		},
		apiIssuer: ISSUER,
		workosJwksUrl: "https://unused.test/jwks",
		workosIssuer: "https://unused.test",
		organizationWorkspacesEnabled,
		workosApiKey: Redacted.make("test-workos-key"),
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
		WorkosVerifierTest,
		ApiStoreMemory,
		CloudWorkspaceStoreMemory,
		CloudBillingStoreMemory,
		MachineStoreMemory,
		MachineProvidersFake,
		BillingProvidersManual,
		Layer.effect(
			SandboxProviders,
			Effect.gen(function* () {
				const providers = yield* SandboxProviders;
				return {
					...providers,
					availableProviders: [yield* providers.get("fake")],
				};
			}),
		).pipe(Layer.provide(SandboxProvidersFake)),
		Layer.effect(
			CloudWorkspaceLaunchIntentCipher,
			CloudWorkspaceLaunchIntentCipherLive,
		).pipe(Layer.provide(config), Layer.orDie),
		Layer.succeed(SandboxOfferConfiguration, {
			port: 47_837,
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
	test("signed renewal survives two days asleep and rejects wrong identity, stale proof and revoked receipt replay", async () => {
		const runtime = await makeRuntime();
		try {
			const store = await runtime.runPromise(CloudWorkspaceStore);
			const keys = await generateKeyPair("EdDSA", { extractable: true });
			const publicJwk = await exportJWK(keys.publicKey);
			const signingThumbprint = await runtime.runPromise(
				runtimeSigningKeyThumbprint(publicJwk),
			);
			const now = Date.now();
			const workspace = {
				workspaceId: "workspace-sleep-renew",
				accountId: "account-1",
				projectId: "project-1",
				buildId: "build-1",
				provider: "fake",
				providerSandboxId: "same-sandbox",
				runtimeCredentialHash: await runtime.runPromise(
					sha256Hex("expired-bearer"),
				),
				runtimeState: "connecting" as const,
				chatId: "same-chat",
				initialSessionId: "same-session",
				branch: "task/sleep",
				baseRef: "main",
				state: "resuming" as const,
				desiredState: "ready" as const,
				statusCode: "resume-runtime-waking",
				idempotencyKey: "sleep-renew",
				requestConfig: {
					runtimeGeneration: 4,
					gatewayEpoch: 8,
					runtimeCredentialExpiresAtMs: now - 2 * 24 * 60 * 60_000,
					runtimeSigningPublicJwk: JSON.stringify(publicJwk),
					runtimeSigningKeyThumbprint: signingThumbprint,
				},
				nextActionAtMs: now + 12_000,
				revision: 1,
				createdAtMs: now,
				updatedAtMs: now,
				lastActivityAtMs: now,
			};
			await runtime.runPromise(
				store.createWorkspace(workspace, {
					workspaceId: workspace.workspaceId,
					accountId: workspace.accountId,
					chatId: workspace.chatId,
					sessionId: workspace.initialSessionId,
					turnId: "turn",
					commandId: "command",
					ciphertext: "sealed",
					expiresAtMs: now + 60_000,
					createdAtMs: now,
				}),
			);
			const proof = (privateKey = keys.privateKey, expired = false) =>
				new SignJWT({
					workspaceId: workspace.workspaceId,
					requestId: "renew-after-sleep",
					generation: 4,
					gatewayEpoch: 8,
				})
					.setProtectedHeader({
						alg: "EdDSA",
						typ: "workspace-runtime-renewal+jwt",
					})
					.setAudience(ISSUER)
					.setIssuedAt(Math.floor(now / 1000) - (expired ? 300 : 0))
					.setExpirationTime(Math.floor(now / 1000) + (expired ? -60 : 120))
					.sign(privateKey);
			const renew = async (signedProof: string) =>
				runtime.runPromise(
					handleRequest(
						new Request(
							`${ISSUER}${ApiPaths.cloudWorkspaceRuntimeCredentialsRenew(workspace.workspaceId)}`,
							{
								method: "POST",
								headers: {
									authorization: "Bearer expired-bearer",
									"content-type": "application/json",
								},
								body: JSON.stringify({
									requestId: "renew-after-sleep",
									proof: signedProof,
								}),
							},
						),
					),
				);
			expect(
				(await renew(await proof((await generateKeyPair("EdDSA")).privateKey)))
					.status,
			).toBe(401);
			expect((await renew(await proof(keys.privateKey, true))).status).toBe(
				401,
			);
			const valid = await proof();
			const first = await renew(valid);
			expect(first.status).toBe(200);
			const receipt = await first.json();
			expect(receipt).toMatchObject({ generation: 4, gatewayEpoch: 8 });
			expect(receipt.expiresAt).toBeGreaterThan(now);
			expect(await (await renew(valid)).json()).toEqual(receipt);
			expect(
				await runtime.runPromise(store.getWorkspace(workspace.workspaceId)),
			).toMatchObject({
				providerSandboxId: "same-sandbox",
				chatId: "same-chat",
				initialSessionId: "same-session",
			});
			await runtime.runPromise(
				store.saveWorkspace({
					...workspace,
					desiredState: "deleted",
					revision: 2,
					updatedAtMs: now + 1,
				}),
			);
			expect((await renew(valid)).status).toBe(401);
		} finally {
			await runtime.dispose();
		}
	});

	test("workspace settings require admin writes, exclude device preferences and reject stale revisions", async () => {
		const runtime = await makeRuntime(true);
		let role = "admin";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) =>
				Response.json({
					data: [
						{
							id: "membership",
							user_id: "alice",
							organization_id: new URL(input).searchParams.get(
								"organization_id",
							),
							status: "active",
							role: { slug: role },
						},
					],
					list_metadata: { after: null },
				}),
			),
		);
		const call = (scope: string, body?: unknown) =>
			runtime.runPromise(
				handleRequest(
					new Request(
						`${ISSUER}${scope === "personal" ? "" : `/v1/organization-workspaces/${scope.slice(13)}`}${ApiPaths.cloudSettings}`,
						{
							method: body === undefined ? "GET" : "PUT",
							headers: {
								authorization: "Bearer test-token:alice",
								"x-zuse-workspace": scope,
								"content-type": "application/json",
							},
							body: body === undefined ? undefined : JSON.stringify(body),
						},
					),
				),
			);
		try {
			for (const scope of [
				"personal",
				"organization:org_a",
				"organization:org_b",
			]) {
				expect(await (await call(scope)).json()).toEqual({
					revision: 0,
					values: {},
				});
				expect(
					await (
						await call(scope, {
							expectedRevision: 0,
							values: {
								branchNamingPrefix: scope,
								appearanceMode: "light",
								providerBinaryPaths: { claude: "/private/path" },
							},
						})
					).json(),
				).toEqual({ revision: 1, values: { branchNamingPrefix: scope } });
			}
			const stale = await call("organization:org_a", {
				expectedRevision: 0,
				values: {},
			});
			expect(stale.status).toBe(409);
			expect(await stale.json()).toEqual({
				error: "workspace_settings_changed",
			});
			role = "member";
			expect(await (await call("organization:org_a")).json()).toEqual({
				revision: 1,
				values: { branchNamingPrefix: "organization:org_a" },
			});
			expect(
				(await call("organization:org_a", { expectedRevision: 1, values: {} }))
					.status,
			).toBe(403);
			role = "billing";
			expect((await call("organization:org_a")).status).toBe(403);
			role = "admin";
			expect(
				(await call("organization:org_a", { expectedRevision: -1, values: {} }))
					.status,
			).toBe(400);
			expect(
				(
					await call("organization:org_a", {
						expectedRevision: 1,
						values: { defaultProviderId: "unknown" },
					})
				).status,
			).toBe(400);
			expect(
				await (
					await call("organization:org_a", { expectedRevision: 1, values: {} })
				).json(),
			).toEqual({ revision: 2, values: {} });
			expect(await (await call("personal")).json()).toEqual({
				revision: 1,
				values: { branchNamingPrefix: "personal" },
			});
		} finally {
			vi.unstubAllGlobals();
			await runtime.dispose();
		}
	});
	test("creates organization-owned chats with future-only defaults and member-bound retries", async () => {
		const runtime = await makeRuntime(true);
		let audience = "organization";
		let subject = "alice";
		let role = "member";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				const url = new URL(input);
				if (url.pathname.startsWith("/organizations/"))
					return Response.json({
						id: "org_a",
						name: "Team",
						metadata: {
							zuse_chat_sharing: JSON.stringify({
								audience,
								permission: "edit",
							}),
						},
					});
				return Response.json({
					data: [
						{
							id: `membership-${subject}`,
							user_id: subject,
							organization_id: "org_a",
							status: "active",
							role: { slug: role },
						},
					],
					list_metadata: { after: null },
				});
			}),
		);
		try {
			const store = await runtime.runPromise(CloudWorkspaceStore);
			const machines = await runtime.runPromise(MachineStore);
			const billing = await runtime.runPromise(CloudBillingStore);
			const now = Date.now();
			const owner = "organization:org_a";
			await runtime.runPromise(
				machines.upsertEntitlement({
					entitlementId: "org-entitlement",
					accountId: owner,
					kind: "cloud-workspace",
					offerId: "cloud-workspace-standard-v1",
					provider: "manual",
					status: "active",
					createdAtMs: now,
					updatedAtMs: now,
				}),
			);
			await runtime.runPromise(
				billing.ensurePeriod({
					periodId: "org-period",
					accountId: owner,
					status: "manual",
					periodStartMs: now - 1000,
					periodEndMs: now + 86_400_000,
					nowMs: now,
				}),
			);
			await runtime.runPromise(
				store.connectProject({
					projectId: "project",
					accountId: owner,
					repositoryIdentity: "github.com/acme/app",
					repositoryUrl: "https://github.com/acme/app.git",
					displayName: "App",
					defaultBranch: "main",
					visibility: "private",
					gitConnectionKind: "github-app",
					cloudEnvironment: {},
					secretBindings: [],
					configurationDigest: "digest",
					state: "ready",
					idempotencyKey: "project",
					createdAtMs: now,
					updatedAtMs: now,
				}),
			);
			await runtime.runPromise(
				store.createBuild({
					buildId: "build",
					projectId: "project",
					accountId: owner,
					provider: "fake",
					snapshotId: "org-image",
					logText: "private build output",
					templateVersion: "test-template",
					configurationDigest: "digest",
					state: "ready",
					idempotencyKey: "build",
					nextActionAtMs: now,
					revision: 1,
					createdAtMs: now,
					updatedAtMs: now,
				}),
			);
			const imageStatus = () =>
				runtime.runPromise(
					handleRequest(
						new Request(`${ISSUER}${ApiPaths.cloudAccountImage}`, {
							headers: {
								authorization: `Bearer test-token:${subject}`,
								"x-zuse-workspace": "organization:org_a",
							},
						}),
					),
				);
			const providerResponse = await runtime.runPromise(
				handleRequest(
					new Request(`${ISSUER}${ApiPaths.cloudProviders}`, {
						headers: {
							authorization: `Bearer test-token:${subject}`,
							"x-zuse-workspace": "organization:org_a",
						},
					}),
				),
			);
			expect(providerResponse.status).toBe(200);
			expect(await providerResponse.json()).toMatchObject({ entitled: true });
			const billingResponse = await runtime.runPromise(
				handleRequest(
					new Request(`${ISSUER}${ApiPaths.billingEntitlements}`, {
						headers: {
							authorization: `Bearer test-token:${subject}`,
							"x-zuse-workspace": "organization:org_a",
						},
					}),
				),
			);
			expect(billingResponse.status).toBe(403);
			const memberImage = await imageStatus();
			expect(memberImage.status).toBe(200);
			const memberImageBody = await memberImage.json();
			expect(memberImageBody).toMatchObject({
				generation: "build",
				repositories: [{ projectId: "project" }],
			});
			expect(JSON.stringify(memberImageBody)).not.toContain(
				"private build output",
			);
			role = "admin";
			expect(await (await imageStatus()).json()).toMatchObject({
				builds: [{ logText: "private build output" }],
			});
			role = "billing";
			expect((await imageStatus()).status).toBe(403);
			role = "member";
			const create = (key: string, branch?: string) =>
				runtime.runPromise(
					handleRequest(
						new Request(`${ISSUER}${ApiPaths.cloudWorkspaces}`, {
							method: "POST",
							headers: {
								authorization: `Bearer test-token:${subject}`,
								"x-zuse-workspace": "organization:org_a",
								"content-type": "application/json",
							},
							body: JSON.stringify({
								projectId: "project",
								providerId: "fake",
								baseRef: "main",
								branch,
								agent: "codex",
								model: "test",
								idempotencyKey: key,
							}),
						}),
					),
				);
			const first = await create("same-key");
			expect(first.status, await first.clone().text()).toBe(201);
			const firstId = (await first.json()).workspace.workspaceId;
			const original = await runtime.runPromise(store.getWorkspace(firstId));
			expect(original).toMatchObject({
				accountId: owner,
				buildId: "build",
				requestConfig: {
					sharingPolicy: {
						audience: "organization",
						permission: "edit",
						creatorSubject: "alice",
						creatorMembershipId: "membership-alice",
						grants: [],
					},
				},
			});
			audience = "private";
			const retry = await create("same-key");
			expect(retry.status).toBe(200);
			expect((await retry.json()).workspace.workspaceId).toBe(firstId);
			expect(
				(await runtime.runPromise(store.getWorkspace(firstId)))?.requestConfig
					.sharingPolicy,
			).toEqual(original?.requestConfig.sharingPolicy);
			subject = "bob";
			const second = await create("same-key");
			expect(second.status).toBe(201);
			const secondId = (await second.json()).workspace.workspaceId;
			expect(secondId).not.toBe(firstId);
			expect(
				(await runtime.runPromise(store.getWorkspace(secondId)))?.requestConfig
					.sharingPolicy,
			).toMatchObject({ audience: "private", creatorSubject: "bob" });
			expect(await runtime.runPromise(store.listWorkspaces("alice"))).toEqual(
				[],
			);
			expect(
				await runtime.runPromise(billing.currentPeriod("alice", now)),
			).toBeNull();
			const catalog = () =>
				runtime.runPromise(
					handleRequest(
						new Request(`${ISSUER}${ApiPaths.cloudChatChanges}?cursor=0`, {
							headers: {
								authorization: `Bearer test-token:${subject}`,
								"x-zuse-workspace": "organization:org_a",
							},
						}),
					),
				);
			expect(await (await catalog()).json()).toMatchObject({
				reset: true,
				deletedWorkspaceIds: [],
				chats: expect.arrayContaining([
					expect.objectContaining({ workspaceId: firstId }),
					expect.objectContaining({ workspaceId: secondId }),
				]),
			});
			subject = "alice";
			const visible = await (await catalog()).json();
			expect(visible.reset).toBe(true);
			expect(
				visible.chats.map((chat: { workspaceId: string }) => chat.workspaceId),
			).toEqual([firstId]);
			expect(visible.deletedWorkspaceIds).toEqual([]);
			const privateWorkspace = await runtime.runPromise(
				store.getWorkspace(secondId),
			);
			if (!privateWorkspace) throw new Error("missing test workspace");
			const collision = await create(
				"branch-collision",
				privateWorkspace.branch,
			);
			expect(collision.status).toBe(409);
			expect(await collision.json()).toEqual({ error: "cloud_branch_in_use" });
		} finally {
			vi.unstubAllGlobals();
			await runtime.dispose();
		}
	});

	test("binds gateway actors and rechecks live membership through fenced runtime credentials", async () => {
		const runtime = await makeRuntime(true);
		let role = "member";
		let active = true;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					data: active
						? [
								{
									id: "membership",
									user_id: "member",
									organization_id: "org_a",
									status: "active",
									role: { slug: role },
								},
							]
						: [],
					list_metadata: { after: null },
				}),
			),
		);
		try {
			const store = await runtime.runPromise(CloudWorkspaceStore);
			const now = Date.now();
			const workspaceId = "org-workspace";
			const credentialHash = await runtime.runPromise(
				sha256Hex("runtime-secret"),
			);
			const workspace = {
				workspaceId,
				accountId: "organization:org_a",
				projectId: "project",
				buildId: "build",
				provider: "fake",
				runtimeState: "online" as const,
				chatId: "chat",
				initialSessionId: "session",
				branch: "branch",
				baseRef: "main",
				state: "ready" as const,
				desiredState: "ready" as const,
				statusCode: "ready",
				idempotencyKey: "org-create",
				runtimeCredentialHash: credentialHash,
				nextActionAtMs: now,
				revision: 1,
				createdAtMs: now,
				updatedAtMs: now,
				lastActivityAtMs: now,
				requestConfig: {
					runtimeGeneration: 4,
					gatewayEpoch: 8,
					runtimeCredentialExpiresAtMs: now + 60_000,
					sharingPolicy: {
						creatorSubject: "creator",
						creatorMembershipId: "creator-membership",
						audience: "organization",
						permission: "view",
						grants: [],
					},
					runtimeBootstrapReceipt: {
						workspaceId,
						bootTokenHash: "boot",
						credentialKeyThumbprint: "key",
						signingKeyThumbprint: "key",
						signingPublicJwk: "{}",
						runtimeCredentialHash: credentialHash,
						runtimeCredentialExpiresAtMs: now + 60_000,
						generation: 4,
						gatewayEpoch: 8,
						sealedTranscriptKey: "sealed",
						enrolledAtMs: now,
						capabilities: [
							CLOUD_RUNTIME_WORKSPACE_AUTHORIZATION_CAPABILITY,
							CLOUD_RUNTIME_GITHUB_EXECUTION_CAPABILITY,
						],
					},
				},
			};
			await runtime.runPromise(
				store.createWorkspace(workspace, {
					workspaceId,
					accountId: workspace.accountId,
					chatId: "chat",
					sessionId: "session",
					turnId: "turn",
					commandId: "launch",
					ciphertext: "unused",
					expiresAtMs: now + 60_000,
					createdAtMs: now,
				}),
			);
			const userRequest = (suffix: string, method: string, scope = "org_a") =>
				runtime.runPromise(
					handleRequest(
						new Request(
							`${ISSUER}/v1/organization-workspaces/${scope}/v1/cloud/workspaces/${workspaceId}/${suffix}`,
							{
								method,
								headers: {
									authorization: "Bearer test-token:member",
									"x-zuse-workspace": `organization:${scope}`,
									"content-type": "application/json",
								},
								body: method === "POST" ? "{}" : undefined,
							},
						),
					),
				);
			for (const [suffix, method] of [
				["data-key", "GET"],
				["commands", "POST"],
				["commands/command", "DELETE"],
				...["pause", "resume", "restart", "archive", "unarchive", "delete"].map(
					(action) => [action, "POST"],
				),
			] as const) {
				const denied = await userRequest(suffix, method);
				expect(denied.status).toBe(403);
				expect(await denied.json()).toEqual({
					error: "workspace_access_denied",
				});
			}
			expect((await userRequest("commands/command", "GET")).status).toBe(200);
			expect(
				(await userRequest("commands/command", "GET", "org_b")).status,
			).toBe(403);
			role = "billing";
			expect((await userRequest("commands/command", "GET")).status).toBe(403);
			role = "admin";
			expect((await userRequest("data-key", "GET")).status).toBe(200);
			role = "member";
			const ticket = await runtime.runPromise(
				Effect.gen(function* () {
					const config = yield* ApiConfiguration;
					return yield* signWorkspaceClientTicket({
						mintPrivateJwk: yield* parseJwk(
							Redacted.value(config.mintPrivateKey),
						),
						issuer: ISSUER,
						accountId: workspace.accountId,
						actorId: "member",
						permission: "edit",
						deviceId: "device",
						workspaceId,
						protocol: "zuse-workspace-v2",
						generation: 4,
						gatewayEpoch: 8,
						ttlMs: 60_000,
						nowMs: now,
					});
				}),
			);
			const connect = () =>
				runtime.runPromise(
					handleRequest(
						new Request(
							`${ISSUER}${ApiPaths.cloudWorkspaceGateway(workspaceId)}`,
							{
								headers: {
									upgrade: "websocket",
									"sec-websocket-protocol": `zuse-workspace-v2, ${ticket}`,
									"x-zuse-gateway-actor": "forged-owner",
								},
							},
						),
					),
				);
			const connected = await connect();
			expect(connected.status).toBe(204);
			expect(connected.headers.get("x-zuse-gateway-actor")).toBe("member");
			expect(connected.headers.get("x-zuse-gateway-permission")).toBe("view");
			const read = (path: string, method = "GET") =>
				runtime.runPromise(
					handleRequest(
						new Request(`${ISSUER}${path}`, {
							method,
							headers: {
								authorization: "Bearer test-token:member",
								"x-zuse-workspace": "organization:org_a",
							},
						}),
					),
				);
			const itemPath = `${ApiPaths.cloudWorkspaces}/${workspaceId}`;
			expect((await read(itemPath)).status).toBe(200);
			expect(await (await read(ApiPaths.cloudWorkspaces)).json()).toMatchObject(
				{
					workspaces: [{ workspaceId }],
				},
			);
			expect((await read(`${itemPath}/gateway/ticket`, "POST")).status).toBe(
				200,
			);
			expect((await read(`${itemPath}/pause`, "POST")).status).toBe(403);
			expect(await (await read(`${itemPath}/sharing`)).json()).toMatchObject({
				policy: { audience: "organization", permission: "view" },
				canManageSharing: false,
			});
			const access = (
				token = "runtime-secret",
				generation = 4,
				actorId = "member",
				membershipId?: string,
			) =>
				runtime.runPromise(
					handleRequest(
						new Request(
							`${ISSUER}${ApiPaths.cloudWorkspaceRuntimeAccess(workspaceId)}`,
							{
								method: "POST",
								headers: {
									authorization: `Bearer ${token}`,
									"content-type": "application/json",
								},
								body: JSON.stringify({
									actorId,
									membershipId,
									runtimeGeneration: generation,
									gatewayEpoch: 8,
								}),
							},
						),
					),
				);
			expect(await (await access()).json()).toEqual({
				permission: "view",
				actor: { subject: "member", membershipId: "membership" },
			});
			expect((await access("invalid")).status).toBe(401);
			expect((await access("runtime-secret", 3)).status).toBe(401);
			expect((await access("runtime-secret", 4, "stranger")).status).toBe(403);
			expect(
				(await access("runtime-secret", 4, "member", "membership")).status,
			).toBe(200);
			expect(
				(await access("runtime-secret", 4, "member", "previous-membership"))
					.status,
			).toBe(403);
			role = "billing";
			expect((await access()).status).toBe(403);
			expect((await connect()).status).toBe(403);
			expect((await read(ApiPaths.cloudWorkspaces)).status).toBe(403);
			expect((await read(itemPath)).status).toBe(403);
			role = "member";
			active = false;
			expect((await access()).status).toBe(403);
			expect((await connect()).status).toBe(403);
			active = true;
			const beforeUpdate = await runtime.runPromise(
				store.getWorkspace(workspaceId),
			);
			if (!beforeUpdate) throw new Error("missing test workspace");
			await runtime.runPromise(
				store.saveWorkspace({
					...beforeUpdate,
					revision: beforeUpdate.revision + 1,
					updatedAtMs: beforeUpdate.updatedAtMs + 1,
					requestConfig: {
						...beforeUpdate.requestConfig,
						runtimeBootstrapReceipt: {
							...workspace.requestConfig.runtimeBootstrapReceipt,
							capabilities: [],
						},
					},
				}),
			);
			expect((await connect()).status).toBe(409);
			const incompatibleTicket = await read(
				`${itemPath}/gateway/ticket`,
				"POST",
			);
			expect(incompatibleTicket.status).toBe(409);
			expect(await incompatibleTicket.json()).toEqual({
				error: "workspace_runtime_update_required",
			});
			const current = await runtime.runPromise(store.getWorkspace(workspaceId));
			if (!current) throw new Error("missing test workspace");
			await runtime.runPromise(
				store.updateWorkspaceSharing({
					workspaceId,
					accountId: workspace.accountId,
					expectedRevision: 0,
					sharing: { audience: "private", permission: "edit", grants: [] },
					nowMs: now + 2,
				}),
			);
			expect(await (await read(ApiPaths.cloudWorkspaces)).json()).toEqual({
				workspaces: [],
			});
			expect((await read(itemPath)).status).toBe(403);
			expect((await read(`${itemPath}/gateway/ticket`, "POST")).status).toBe(
				403,
			);
			expect(
				(await read(`${itemPath}/sessions/session/transcript-checkpoint`))
					.status,
			).toBe(403);
			expect(
				(await read(`${itemPath}/sessions/session/transcript-message-page`))
					.status,
			).toBe(403);
			role = "admin";
			expect((await read(itemPath)).status).toBe(200);
			const sharing = await (await read(`${itemPath}/sharing`)).json();
			const updateSharing = (
				grants: ReadonlyArray<{ membershipId: string; permission: "view" }>,
			) =>
				runtime.runPromise(
					handleRequest(
						new Request(`${ISSUER}${itemPath}/sharing`, {
							method: "PUT",
							headers: {
								authorization: "Bearer test-token:member",
								"x-zuse-workspace": "organization:org_a",
								"content-type": "application/json",
							},
							body: JSON.stringify({
								expectedRevision: sharing.revision,
								audience: "private",
								permission: "view",
								grants,
							}),
						}),
					),
				);
			expect(
				(
					await updateSharing([
						{ membershipId: "foreign-member", permission: "view" },
					])
				).status,
			).toBe(400);
			const grant = { membershipId: "membership", permission: "view" as const };
			expect((await updateSharing([grant, grant])).status).toBe(400);
			const granted = await updateSharing([grant]);
			expect(granted.status).toBe(200);
			expect(await granted.json()).toMatchObject({
				policy: {
					creatorSubject: "creator",
					creatorMembershipId: "creator-membership",
					grants: [grant],
				},
			});
			expect((await updateSharing([])).status).toBe(409);
			role = "member";
			expect((await read(itemPath)).status).toBe(200);
			expect((await updateSharing([])).status).toBe(403);
			expect(await (await read(ApiPaths.cloudWorkspaces)).json()).toMatchObject(
				{
					workspaces: [{ workspaceId }],
				},
			);
		} finally {
			vi.unstubAllGlobals();
			await runtime.dispose();
		}
	});

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
			store.connectProject({
				projectId: "project-1",
				accountId: "account-1",
				repositoryIdentity: "github.com/acme/example",
				repositoryUrl: "https://github.com/acme/example.git",
				displayName: "example",
				defaultBranch: "main",
				visibility: "private",
				gitConnectionKind: "github-app",
				cloudEnvironment: {},
				secretBindings: [],
				configurationDigest: "digest",
				state: "ready",
				idempotencyKey: "project-key",
				createdAtMs: now,
				updatedAtMs: now,
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
		expect(first.providerSandboxId).toBe("fake-sandbox");
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
		const githubCredential = await runtime.runPromise(
			handleRequest(
				new Request(
					`${ISSUER}${ApiPaths.cloudWorkspaceRuntimeGithubCredential(workspaceId)}`,
					{
						method: "POST",
						headers: { authorization: `Bearer ${credential}` },
					},
				),
			),
		);
		const forContext = (context: unknown) =>
			runtime.runPromise(
				handleRequest(
					new Request(
						`${ISSUER}${ApiPaths.cloudWorkspaceRuntimeGithubCredential(workspaceId)}`,
						{
							method: "POST",
							headers: {
								authorization: `Bearer ${credential}`,
								"content-type": "application/json",
							},
							body: JSON.stringify(context),
						},
					),
				),
			);
		for (const context of [
			{ actor: { subject: "someone-else", membershipId: "fake" } },
			{ slackMessageId: "missing" },
		])
			expect((await forContext(context)).status).toBe(403);
		const slackMessageId = "slack-message";
		await runtime.runPromise(
			store.appendApiMessage({
				messageId: slackMessageId,
				workspaceId,
				accountId: "account-1",
				role: "user",
				sealedContent: await runtime.runPromise(
					sealApiString(
						apiMessageSealContext("account-1", workspaceId, slackMessageId),
						encodeApiMessageContent({
							text: "commit",
							attachments: [],
							githubBot: true,
						}),
					),
				),
				status: "delivered",
				createdAtMs: now,
			}),
		);
		expect(githubCredential.status).toBe(403);
		expect(await githubCredential.json()).toEqual({
			error: "github_user_connection_required",
		});
		const personal = {
			name: "Octo Cat",
			email: "123+octocat@users.noreply.github.com",
		};
		await runtime.runPromise(
			store.saveGithubUser({
				accountId: "account-1",
				login: "octocat",
				...personal,
				sealedCredentials: await runtime.runPromise(
					sealApiString(
						"github-user\naccount-1",
						JSON.stringify({
							accessToken: "ghu_personal",
							expiresAtMs: now + 3_600_000,
						}),
					),
				),
			}),
		);
		await runtime.runPromise(
			store.saveGithubInstallation({
				accountId: "account-1",
				installationId: 99,
				githubAccountId: 100,
				accountLogin: "acme",
				accountType: "Organization",
				repositorySelection: "selected",
				suspended: false,
				createdAtMs: now,
				updatedAtMs: now,
			}),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				if (url.includes("/users/"))
					return Response.json({ id: 42, login: "zuse[bot]" });
				expect(JSON.parse(String(init?.body))).toEqual({
					repositories: ["example"],
					permissions: { contents: "write", pull_requests: "write" },
				});
				return Response.json({
					token: "bot-token",
					expires_at: new Date(now + 3600000).toISOString(),
				});
			}),
		);
		const botResponse = await forContext({ slackMessageId });
		expect(botResponse.status).toBe(200);
		expect(await botResponse.json()).toMatchObject({
			token: "bot-token",
			identity: {
				name: "zuse[bot]",
				email: "42+zuse[bot]@users.noreply.github.com",
			},
		});
		vi.unstubAllGlobals();
		const withIdentity = await bootstrap();
		expect((await withIdentity.json()).gitIdentity).toMatchObject(personal);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					token: "ghu_scoped",
					expires_at: new Date(now + 3600000).toISOString(),
				}),
			),
		);
		try {
			const personalCredential = await runtime.runPromise(
				handleRequest(
					new Request(
						`${ISSUER}${ApiPaths.cloudWorkspaceRuntimeGithubCredential(workspaceId)}`,
						{
							method: "POST",
							headers: { authorization: `Bearer ${credential}` },
						},
					),
				),
			);
			expect(personalCredential.status).toBe(200);
			expect(await personalCredential.json()).toMatchObject({
				token: "ghu_scoped",
				identity: personal,
			});
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => Response.json({}, { status: 403 })),
			);
			const denied = await runtime.runPromise(
				handleRequest(
					new Request(
						`${ISSUER}${ApiPaths.cloudWorkspaceRuntimeGithubCredential(workspaceId)}`,
						{
							method: "POST",
							headers: { authorization: `Bearer ${credential}` },
						},
					),
				),
			);
			expect(denied.status).toBe(503);
			expect(await denied.json()).toMatchObject({
				error: "github_user_repository_access_required",
			});
		} finally {
			vi.unstubAllGlobals();
		}
		const rejectedGithubCredential = await runtime.runPromise(
			handleRequest(
				new Request(
					`${ISSUER}${ApiPaths.cloudWorkspaceRuntimeGithubCredential(workspaceId)}`,
					{
						method: "POST",
						headers: { authorization: "Bearer wrong-runtime" },
					},
				),
			),
		);
		expect(rejectedGithubCredential.status).toBe(401);
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
		const mailboxWakeAt = Date.now();
		expect(
			await runtime.runPromise(
				store.requestMailboxWake(
					workspaceId,
					"account-1",
					mailboxWakeAt,
					mailboxWakeAt + 60_000,
				),
			),
		).toMatchObject({
			desiredState: "ready",
			nextActionAtMs: mailboxWakeAt,
			requestConfig: { cloudMailboxWakePending: true },
		});
		const pauseDuringMailboxDrain = await runtime.runPromise(
			handleRequest(
				new Request(
					`${ISSUER}${ApiPaths.cloudWorkspaceAction(workspaceId, "pause")}`,
					{
						method: "POST",
						headers: {
							authorization: "Bearer test-token:account-1",
							"content-type": "application/json",
						},
						body: JSON.stringify({
							workspaceId,
							commandId: "pause-during-mailbox-drain",
						}),
					},
				),
			),
		);
		expect(pauseDuringMailboxDrain.status).toBe(409);
		expect(await pauseDuringMailboxDrain.json()).toMatchObject({
			error: "cloud_workspace_mailbox_wake_pending",
		});
		expect(
			await runtime.runPromise(store.getWorkspace(workspaceId)),
		).toMatchObject({
			desiredState: "ready",
			nextActionAtMs: mailboxWakeAt,
			requestConfig: { cloudMailboxWakePending: true },
		});

		const beforeDelete = await runtime.runPromise(
			store.getWorkspace(workspaceId),
		);
		if (beforeDelete === null)
			throw new Error("workspace disappeared before delete-fence test");
		const deleteTransition = await runtime.runPromise(
			store.transitionWorkspaceLifecycle({
				workspace: {
					...beforeDelete,
					desiredState: "deleted",
					statusCode: "delete-queued",
					nextActionAtMs: now + 2,
					revision: beforeDelete.revision + 1,
					updatedAtMs: now + 2,
				},
				expectedRevision: beforeDelete.revision,
				expectedUpdatedAtMs: beforeDelete.updatedAtMs,
				expectedState: beforeDelete.state,
				expectedDesiredState: beforeDelete.desiredState,
				commandId: "delete-for-runtime-receipt",
				action: "delete",
				createdAtMs: now + 2,
			}),
		);
		expect(deleteTransition).toMatchObject({
			kind: "applied",
			workspace: { desiredState: "deleted" },
		});

		const runtimeCommandAck = {
			commandId: "leased-command",
			leaseToken: "original-lease-token",
			fingerprint: "hmac-sha256:leased-command",
			state: "applied",
		};
		const receiptDuringDelete = await runtime.runPromise(
			handleRequest(
				new Request(
					`${ISSUER}${ApiPaths.cloudWorkspaceRuntimeCommandAck(workspaceId)}`,
					{
						method: "POST",
						headers: {
							authorization: `Bearer ${credential}`,
							"content-type": "application/json",
						},
						body: JSON.stringify(runtimeCommandAck),
					},
				),
			),
		);
		expect(receiptDuringDelete.status).toBe(200);
		expect(takeCloudMailboxDirective(receiptDuringDelete)).toEqual({
			kind: "directive",
			directive: {
				command: { action: "ack", workspaceId },
			},
		});
		expect(await receiptDuringDelete.json()).toEqual(runtimeCommandAck);

		const leaseDuringDelete = await runtime.runPromise(
			handleRequest(
				new Request(
					`${ISSUER}${ApiPaths.cloudWorkspaceRuntimeCommandLease(workspaceId)}`,
					{
						method: "POST",
						headers: {
							authorization: `Bearer ${credential}`,
							"content-type": "application/json",
						},
						body: JSON.stringify({ storageIncarnationId: "storage-1" }),
					},
				),
			),
		);
		expect(leaseDuringDelete.status).toBe(401);
		await runtime.dispose();
	});
});

test("provider connections require account authentication and organization administration", async () => {
	const runtime = await makeRuntime(true);
	let role = "admin";
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string) =>
			Response.json({
				data: [
					{
						id: "membership",
						user_id: "alice",
						organization_id: new URL(input).searchParams.get("organization_id"),
						status: "active",
						role: { slug: role },
					},
				],
				list_metadata: { after: null },
			}),
		),
	);
	const call = (scope: string, method = "GET", authenticated = true) =>
		runtime.runPromise(
			handleRequest(
				new Request(`${ISSUER}${ApiPaths.cloudProviderConnections}`, {
					method,
					headers: {
						...(authenticated
							? { authorization: "Bearer test-token:alice" }
							: {}),
						"x-zuse-workspace": scope,
						"content-type": "application/json",
					},
					...(method === "GET"
						? {}
						: { body: JSON.stringify({ connectionId: "retained" }) }),
				}),
			),
		);
	try {
		expect((await call("personal", "GET", false)).status).toBe(401);
		const personal = await call("personal");
		expect(personal.status).toBe(200);
		expect(personal.headers.get("cache-control")).toBe("no-store");
		expect(await personal.json()).toEqual({
			connections: [],
			customSnapshotsEnabled: false,
		});
		expect((await call("organization:org_a")).status).toBe(200);
		for (const deniedRole of ["member", "billing"]) {
			role = deniedRole;
			for (const method of ["GET", "POST", "DELETE"])
				expect((await call("organization:org_a", method)).status).toBe(403);
		}
	} finally {
		vi.unstubAllGlobals();
		await runtime.dispose();
	}
});

test("free provider keys pin image builds and cannot authorize managed compute", async () => {
	const runtime = await makeRuntime();
	const records: ProviderConnectionRecord[] = [];
	const connections = CloudProviderConnections.of({
		list: (accountId) =>
			Effect.succeed(
				records.filter((record) => record.accountId === accountId),
			),
		save: (record) =>
			Effect.sync(() => {
				records.push(record);
			}),
		disconnect: () => Effect.void,
	});
	try {
		const registry = await runtime.runPromise(SandboxProviders);
		const fake = await runtime.runPromise(registry.get("fake"));
		const own = {
			...fake,
			providerId: "boxd",
			withCredentials: () => ({ ...fake, providerId: "boxd" }),
		};
		const providers = await runtime.runPromise(
			makeSandboxProviders({
				defaultProviderId: "fake",
				registrations: [{ adapter: fake }, { adapter: own }],
			}),
		);
		const call = (path: string, body?: unknown) =>
			runtime.runPromise(
				handleRequest(
					new Request(`${ISSUER}${path}`, {
						method: body === undefined ? "GET" : "POST",
						headers: {
							authorization: "Bearer test-token:alice",
							"content-type": "application/json",
						},
						...(body === undefined ? {} : { body: JSON.stringify(body) }),
					}),
				).pipe(
					Effect.provideService(CloudProviderConnections, connections),
					Effect.provideService(SandboxProviders, providers),
				),
			);
		const saved = await call(ApiPaths.cloudProviderConnections, {
			providerId: "boxd",
			apiKey: "customer-key",
		});
		expect(saved.status).toBe(200);
		expect(await saved.text()).not.toContain("customer-key");
		const available = await call(ApiPaths.cloudProviders);
		expect(await available.json()).toMatchObject({
			entitled: true,
			providers: [{ providerId: "boxd", billingSource: "provider" }],
		});
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await runtime.runPromise(
			store.connectProject({
				projectId: "project",
				accountId: "alice",
				repositoryIdentity: "github.com/acme/app",
				repositoryUrl: "https://github.com/acme/app.git",
				displayName: "App",
				defaultBranch: "main",
				visibility: "private",
				gitConnectionKind: "github-app",
				cloudEnvironment: {},
				secretBindings: [],
				configurationDigest: "digest",
				state: "ready",
				idempotencyKey: "project",
				createdAtMs: 1,
				updatedAtMs: 1,
			}),
		);
		const buildResponse = await call(ApiPaths.cloudAccountImageBuild, {
			providerId: "boxd",
			idempotencyKey: "own-build",
			mode: "rebuild",
		});
		expect(buildResponse.status).toBe(202);
		const builds = await runtime.runPromise(
			store.listAccountBuilds("alice", "boxd"),
		);
		expect(builds).toHaveLength(1);
		expect(builds[0]?.settings?.providerConnectionId).toBe(
			records[0]?.connectionId,
		);
		expect(builds[0]?.templateVersion).toContain(records[0]?.connectionId);
		const denied = await call(ApiPaths.cloudAccountImageBuild, {
			providerId: "fake",
			idempotencyKey: "managed-build",
			mode: "rebuild",
		});
		expect(denied.status).toBe(403);
	} finally {
		await runtime.dispose();
	}
});

test.each([
	"immutable-snapshot",
	"my-snapshot-name",
])("custom snapshot import %s is gated, connection-pinned and idempotent", async (snapshotReference) => {
	const runtime = await makeRuntime();
	const records: ProviderConnectionRecord[] = [];
	const connections = CloudProviderConnections.of({
		list: (accountId) =>
			Effect.succeed(
				records.filter((record) => record.accountId === accountId),
			),
		save: (record) =>
			Effect.sync(() => {
				records.push(record);
			}),
		disconnect: () => Effect.void,
	});
	try {
		const config = await runtime.runPromise(ApiConfiguration);
		const fake = await runtime.runPromise(
			(await runtime.runPromise(SandboxProviders)).get("fake"),
		);
		const resolveSnapshotSource = vi.fn(() =>
			Effect.succeed({ snapshotId: "immutable-snapshot", version: 3 }),
		);
		const own = {
			...fake,
			providerId: "boxd",
			resolveSnapshotSource,
		};
		const providers = await runtime.runPromise(
			makeSandboxProviders({
				defaultProviderId: "boxd",
				registrations: [{ adapter: { ...own, withCredentials: () => own } }],
			}),
		);
		const call = (path: string, body?: unknown, enabled = true) =>
			runtime.runPromise(
				handleRequest(
					new Request(`${ISSUER}${path}`, {
						method: body === undefined ? "GET" : "POST",
						headers: {
							authorization: "Bearer test-token:alice",
							"content-type": "application/json",
						},
						...(body === undefined ? {} : { body: JSON.stringify(body) }),
					}),
				).pipe(
					Effect.provideService(ApiConfiguration, {
						...config,
						cloudBoxdCustomSnapshotsEnabled: enabled,
					}),
					Effect.provideService(CloudProviderConnections, connections),
					Effect.provideService(SandboxProviders, providers),
				),
			);
		expect(
			(
				await call(ApiPaths.cloudProviderConnections, {
					providerId: "boxd",
					apiKey: "own-key",
				})
			).status,
		).toBe(200);
		const connectionId = records[0]?.connectionId;
		const body = {
			connectionId,
			snapshotId: snapshotReference,
			runtimeUser: "developer",
			repositoryPaths: [],
			idempotencyKey: "import-one",
		};
		expect((await call(ApiPaths.cloudSnapshotImport, body, false)).status).toBe(
			409,
		);
		expect(
			(
				await call(ApiPaths.cloudSnapshotImport, {
					...body,
					connectionId: "someone-else",
				})
			).status,
		).toBe(403);
		expect((await call(ApiPaths.cloudSnapshotImport, body)).status).toBe(202);
		expect(resolveSnapshotSource).toHaveBeenCalledWith(snapshotReference);
		resolveSnapshotSource.mockImplementation(() =>
			Effect.succeed({ snapshotId: "replacement-snapshot", version: 4 }),
		);
		expect((await call(ApiPaths.cloudSnapshotImport, body)).status).toBe(202);
		expect(
			(
				await call(ApiPaths.cloudSnapshotImport, {
					...body,
					runtimeUser: "other",
				})
			).status,
		).toBe(409);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		const builds = await runtime.runPromise(
			store.listAccountBuilds("alice", "boxd"),
		);
		expect(resolveSnapshotSource).toHaveBeenCalledTimes(1);
		expect(builds).toHaveLength(1);
		expect(builds[0]?.projectId).toBeNull();
		expect(builds[0]?.settings).toMatchObject({
			source: "custom-snapshot",
			providerConnectionId: connectionId,
			snapshotVersion: 3,
			snapshot: { snapshotId: "immutable-snapshot" },
		});
		expect(await runtime.runPromise(store.listProjects("alice"))).toHaveLength(
			0,
		);
	} finally {
		await runtime.dispose();
	}
});

describe("cloud runtime orchestration", () => {
	test("authenticates runtime delegation, isolates accounts, and fences expired credentials", async () => {
		const runtime = await makeRuntime();
		try {
			const store = await runtime.runPromise(CloudWorkspaceStore);
			const now = Date.now();
			const seed = async (
				workspaceId: string,
				accountId: string,
				expiresAt = now + 60_000,
			) => {
				await runtime.runPromise(
					store.createWorkspace(
						{
							workspaceId,
							accountId,
							projectId: "project",
							buildId: "build",
							provider: "fake",
							providerSandboxId: "sandbox",
							runtimeState: "online",
							chatId: `chat-${workspaceId}`,
							initialSessionId: `session-${workspaceId}`,
							branch: workspaceId,
							baseRef: "main",
							state: "ready",
							desiredState: "ready",
							statusCode: "ready",
							idempotencyKey: workspaceId,
							runtimeCredentialHash: await runtime.runPromise(
								sha256Hex("runtime-secret"),
							),
							nextActionAtMs: now,
							revision: 1,
							createdAtMs: now,
							updatedAtMs: now,
							lastActivityAtMs: now,
							requestConfig: { runtimeCredentialExpiresAtMs: expiresAt },
						},
						{
							workspaceId,
							accountId,
							chatId: `chat-${workspaceId}`,
							sessionId: `session-${workspaceId}`,
							turnId: "turn",
							commandId: `launch-${workspaceId}`,
							ciphertext: "unused",
							expiresAtMs: now + 60_000,
							createdAtMs: now,
						},
					),
				);
			};
			await seed("source", "alice");
			await seed("sibling", "alice");
			await seed("foreign", "bob");
			await seed("expired", "alice", now - 1);
			await seed("organization", "organization:org");
			const call = (
				path: string,
				method = "GET",
				source = "source",
				token = "runtime-secret",
				body?: unknown,
			) =>
				runtime.runPromise(
					handleRequest(
						new Request(
							`${ISSUER}/v1/cloud/workspaces/${source}/runtime/control`,
							{
								method: "POST",
								headers: {
									authorization: `Bearer ${token}`,
									"content-type": "application/json",
								},
								body: JSON.stringify({ path, method, body }),
							},
						),
					),
				);
			const list = await call("/v1/cloud/workspaces");
			expect(list.status).toBe(200);
			expect(
				(await list.json()).workspaces.map(
					(workspace: { workspaceId: string }) => workspace.workspaceId,
				),
			).not.toContain("foreign");
			expect((await call("/v1/cloud/workspaces/sibling")).status).toBe(200);
			expect((await call("/v1/cloud/workspaces/foreign")).status).toBe(404);
			expect(
				(
					await call(
						"/v1/cloud/workspaces/foreign/preview-url",
						"POST",
						"source",
						"runtime-secret",
						{ port: 8123 },
					)
				).status,
			).toBe(404);
			const preview = await call(
				"/v1/cloud/workspaces/source/preview-url",
				"POST",
				"source",
				"runtime-secret",
				{ port: 8123 },
			);
			expect(preview.status).toBe(200);
			expect(await preview.json()).toMatchObject({
				workspaceId: "source",
				port: 8123,
				url: expect.any(String),
			});
			expect((await call("/v1/cloud/api-keys", "POST")).status).toBe(403);
			expect(
				(await call("/v1/cloud/workspaces", "GET", "source", "wrong")).status,
			).toBe(401);
			expect(
				(await call("/v1/cloud/workspaces", "GET", "expired")).status,
			).toBe(401);
			expect(
				(await call("/v1/cloud/workspaces", "GET", "organization")).status,
			).toBe(403);
		} finally {
			await runtime.dispose();
		}
	});
});
