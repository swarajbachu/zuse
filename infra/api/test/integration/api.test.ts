import {
	type BillingProviderAdapter,
	BillingProviderError,
	BillingProviders,
	BillingProvidersManual,
} from "@zuse/billing-providers";
import {
	ApiPaths,
	CLOUD_WORKSPACE_OFFER_ID,
	CloudAuthStatus,
	WORKSPACE_API_PREFIX,
	WORKSPACE_SCOPE_HEADER,
} from "@zuse/contracts";
import { MachineProvidersFake } from "@zuse/machine-providers/testing";
import {
	type SandboxProviderAdapter,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { SandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import {
	exportJWK,
	generateKeyPair,
	importJWK,
	type JWK,
	jwtVerify,
	SignJWT,
} from "jose";
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as CloudAuthAuthority from "../../src/cloud-auth-authority.ts";
import { routeCloudWorkspaceRequest } from "../../src/cloud-workspace-routes.ts";
import { CloudWorkspaceStore } from "../../src/cloud-workspace-store.ts";
import * as Config from "../../src/config.ts";
import type { ApiContext } from "../../src/handler.ts";
import {
	AccountIdentity,
	ApiStoreMemory,
	CloudBillingStoreMemory,
	CloudWorkspaceLaunchIntentCipher,
	CloudWorkspaceLaunchIntentCipherLive,
	CloudWorkspaceStoreMemory,
	type MachineControlConfig,
	MachineControlConfiguration,
	MachineStoreMemory,
	ManagedTunnelProviderLive,
	makeApi,
	PushDelivery,
} from "../../src/index.ts";
import { SandboxOfferConfiguration } from "../../src/sandbox-provider-module.ts";
import { WorkosVerifierTest } from "../../src/workos.ts";

const API_ISSUER = "https://api.test";

// --- test client key material -------------------------------------------------

interface KeyPair {
	readonly publicKey: CryptoKey;
	readonly privateKey: CryptoKey;
}

const eddsa = () => generateKeyPair("EdDSA", { extractable: true });
const ec = () => generateKeyPair("ES256", { extractable: true });

const nowSec = () => Math.floor(Date.now() / 1000);

const signLinkProof = async (
	envKey: KeyPair,
	input: { challenge: string; environmentId: string },
): Promise<string> =>
	new SignJWT({
		challenge: input.challenge,
		environmentId: input.environmentId,
	})
		.setProtectedHeader({ alg: "EdDSA", typ: "environment-link-proof+jwt" })
		.setAudience(API_ISSUER)
		.setIssuedAt(nowSec())
		.setExpirationTime(nowSec() + 300)
		.sign(envKey.privateKey);

const dpopProof = async (
	deviceKey: KeyPair,
	jwk: JWK,
	input: { method: string; url: string; jti?: string },
): Promise<string> =>
	new SignJWT({
		htm: input.method,
		htu: input.url,
		jti: input.jti ?? crypto.randomUUID(),
	})
		.setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
		.setIssuedAt(nowSec())
		.sign(deviceKey.privateKey);

// --- harness ------------------------------------------------------------------

let api: ReturnType<typeof makeApi>;
let mintKey: KeyPair;
let pushCalls: ReadonlyArray<{
	readonly to: string;
	readonly environmentId: string;
	readonly kind: string;
	readonly title?: string;
	readonly target: string;
}>[];
let identityDeletes: string[];
let verifiedIdentityEmail: string | null;

const placementAdapter = (providerId: string): SandboxProviderAdapter => ({
	providerId,
	displayName: "Fast compute",
	templateVersion: "test-template",
	preservesProcessesOnResume: true,
	resources: { vcpuCount: 2, memoryMib: 1_024 },
	sizes: [
		{ sizeId: "test", displayName: "Test", vcpuCount: 2, memoryMib: 1_024 },
	],
	create: () => Effect.die("unused"),
	fork: () => Effect.die("unused"),
	recoverByLabel: () => Effect.succeed(null),
	startProcess: () => Effect.void,
	replaceProcess: () => Effect.void,
	pathExists: () => Effect.succeed(false),
	readTextFile: () => Effect.succeed(""),
	writeTextFile: () => Effect.void,
	inspect: () => Effect.succeed(null),
	resolveEndpoint: () => Effect.die("unused"),
	pause: () => Effect.void,
	resume: () => Effect.die("unused"),
	extendTimeout: () => Effect.void,
	setNetwork: () => Effect.void,
	snapshot: () => Effect.die("unused"),
	kill: () => Effect.void,
	deleteSnapshot: () => Effect.void,
});

const makeLayer = async (
	managedTunnel?: Config.ManagedTunnelConfig,
	billingLayerOrMaxEnvironments:
		| Layer.Layer<BillingProviders>
		| number = BillingProvidersManual,
	liveCheckoutEnabled = false,
	machineControlOverrides: Partial<MachineControlConfig> = {},
	sandboxProvidersLayer: Layer.Layer<SandboxProviders> = SandboxProvidersFake,
	publicApiOrigin?: string,
	organizationWorkspacesEnabled = false,
): Promise<Layer.Layer<ApiContext>> => {
	const billingLayer =
		typeof billingLayerOrMaxEnvironments === "number"
			? BillingProvidersManual
			: billingLayerOrMaxEnvironments;
	const maxEnvironmentsPerAccount =
		typeof billingLayerOrMaxEnvironments === "number"
			? billingLayerOrMaxEnvironments
			: undefined;
	mintKey = (await eddsa()) as KeyPair;
	const configLayer = Config.layer({
		organizationWorkspacesEnabled,
		apiIssuer: API_ISSUER,
		publicApiOrigin,
		workosJwksUrl: "https://unused.test/jwks",
		workosIssuer: "https://unused.test",
		workosApiKey: Redacted.make("test-workos-key"),
		mintPrivateKey: Redacted.make(
			JSON.stringify(await exportJWK(mintKey.privateKey)),
		),
		mintPublicKey: JSON.stringify(await exportJWK(mintKey.publicKey)),
		cloudDataEncryptionKey: Redacted.make(
			"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		),
		managedTunnel,
		maxEnvironmentsPerAccount,
	});
	const pushLayer = Layer.succeed(
		PushDelivery,
		PushDelivery.of({
			send: (notifications) => {
				pushCalls = [...pushCalls, notifications];
				return Effect.void;
			},
		}),
	);
	const accountIdentityLayer = Layer.succeed(
		AccountIdentity,
		AccountIdentity.of({
			verifiedEmail: () => Effect.succeed(verifiedIdentityEmail),
			deleteUser: (accountId) =>
				Effect.sync(() => {
					identityDeletes.push(accountId);
				}),
		}),
	);
	return Layer.mergeAll(
		configLayer,
		WorkosVerifierTest,
		ApiStoreMemory,
		MachineStoreMemory,
		CloudWorkspaceStoreMemory,
		CloudBillingStoreMemory,
		Layer.effect(
			CloudWorkspaceLaunchIntentCipher,
			CloudWorkspaceLaunchIntentCipherLive,
		).pipe(Layer.provide(configLayer), Layer.orDie),
		MachineProvidersFake,
		sandboxProvidersLayer,
		Layer.succeed(SandboxOfferConfiguration, {
			port: 47_837,
			createTimeoutSeconds: 86_400,
			keepAliveTimeoutSeconds: 86_400,
		}),
		billingLayer,
		Layer.succeed(MachineControlConfiguration, {
			allowlistedAccountIds: new Set(["user_a", "user_b"]),
			manualEntitlementsEnabled: true,
			liveCheckoutEnabled,
			enrollmentTtlMs: 30 * 60 * 1_000,
			recoveryWindowMs: 7 * 24 * 60 * 60 * 1_000,
			finalSnapshotRetentionMs: 14 * 24 * 60 * 60 * 1_000,
			reconcileLeaseMs: 5 * 60 * 1_000,
			...machineControlOverrides,
		}),
		ManagedTunnelProviderLive.pipe(Layer.provide(configLayer)),
		pushLayer,
		accountIdentityLayer,
	);
};

const requestEnvironmentLink = async (input: {
	account: string;
	environmentId: string;
	runtimeVersion?: string;
	wireProtocolVersion?: number;
	endpoint?: {
		readonly httpBaseUrl: string;
		readonly wsBaseUrl: string;
	};
}): Promise<{ envKey: KeyPair; response: Response }> => {
	const bearer = `test-token:${input.account}`;
	const challengeRes = await api.fetch(
		new Request(`${API_ISSUER}/v1/client/environment-link-challenges`, {
			method: "POST",
			headers: { authorization: `Bearer ${bearer}` },
		}),
	);
	expect(challengeRes.status).toBe(200);
	const challenge = (await challengeRes.json()) as {
		challengeId: string;
		challenge: string;
	};

	const envKey = (await eddsa()) as KeyPair;
	const proof = await signLinkProof(envKey, {
		challenge: challenge.challenge,
		environmentId: input.environmentId,
	});
	const linkRes = await api.fetch(
		new Request(`${API_ISSUER}/v1/client/environment-links`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${bearer}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				challengeId: challenge.challengeId,
				proof,
				environmentId: input.environmentId,
				environmentPublicKey: JSON.stringify(await exportJWK(envKey.publicKey)),
				providerKind: "desktop",
				endpoint: input.endpoint ?? {
					httpBaseUrl: "http://127.0.0.1:8787",
					wsBaseUrl: "ws://127.0.0.1:8787/rpc",
				},
				label: "Test Mac",
				runtimeVersion: input.runtimeVersion,
				wireProtocolVersion: input.wireProtocolVersion,
				capabilities: {
					version: 1,
					features: ["agents", "files", "terminals"],
				},
				serviceState: "healthy",
			}),
		}),
	);
	return { envKey, response: linkRes };
};

const linkEnvironment = async (input: {
	account: string;
	environmentId: string;
	runtimeVersion?: string;
	wireProtocolVersion?: number;
	endpoint?: {
		readonly httpBaseUrl: string;
		readonly wsBaseUrl: string;
	};
}): Promise<{ envKey: KeyPair; credential: string }> => {
	const { envKey, response: linkRes } = await requestEnvironmentLink(input);
	expect(linkRes.status).toBe(200);
	const linked = (await linkRes.json()) as { environmentCredential: string };
	return { envKey, credential: linked.environmentCredential };
};

const heartbeat = (
	environmentId: string,
	credential: string,
	privateEndpoint?: {
		readonly httpBaseUrl: string;
		readonly wsBaseUrl: string;
	},
) =>
	api.fetch(
		new Request(`${API_ISSUER}/v1/environments/${environmentId}/heartbeat`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${credential}`,
				...(privateEndpoint === undefined
					? {}
					: { "content-type": "application/json" }),
			},
			body:
				privateEndpoint === undefined
					? undefined
					: JSON.stringify({ privateEndpoint }),
		}),
	);

// Obtain a DPoP-bound access token for a device on `account`.
const mintAccess = async (
	account: string,
	device: KeyPair,
	jwk: JWK,
): Promise<string> => {
	const url = `${API_ISSUER}/v1/client/dpop-token`;
	const res = await api.fetch(
		new Request(url, {
			method: "POST",
			headers: {
				authorization: `Bearer test-token:${account}`,
				dpop: await dpopProof(device, jwk, { method: "POST", url }),
			},
		}),
	);
	expect(res.status).toBe(200);
	return ((await res.json()) as { accessToken: string }).accessToken;
};

beforeEach(async () => {
	pushCalls = [];
	identityDeletes = [];
	verifiedIdentityEmail = null;
	api = makeApi(await makeLayer());
});

describe("@zuse/api", () => {
	test.each([
		undefined,
		"personal",
		"organization:org_b",
	])("rejects a scoped URL with missing or mismatched scope (%s)", async (scope) => {
		const response = await api.fetch(
			new Request(
				`${API_ISSUER}${WORKSPACE_API_PREFIX}org_a${ApiPaths.billingPortal}`,
				{
					method: "POST",
					headers: {
						authorization: "Bearer test-token:user_a",
						...(scope === undefined ? {} : { [WORKSPACE_SCOPE_HEADER]: scope }),
					},
				},
			),
		);
		expect(response.status).toBe(400);
	});
	test.each([
		"/v1/environments",
		"/v1/auth/token",
		"/v1/keys",
	])("rejects explicit organization scope on unmigrated route %s", async (path) => {
		const response = await api.fetch(
			new Request(`${API_ISSUER}${path}`, {
				headers: {
					authorization: "Bearer test-token:user_a",
					[WORKSPACE_SCOPE_HEADER]: "organization:org_a",
				},
			}),
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "workspace_scope_not_supported",
		});
	});

	test("keeps migrated organization catalog access behind the rollout gate", async () => {
		const response = await api.fetch(
			new Request(`${API_ISSUER}/v1/cloud/chats`, {
				headers: {
					authorization: "Bearer test-token:user_a",
					[WORKSPACE_SCOPE_HEADER]: "organization:org_a",
				},
			}),
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "organization_workspaces_disabled",
		});
	});

	test("uses independent workspace owners for checkout and portal without transferring Personal subscriptions", async () => {
		const checkoutOwners: string[] = [];
		const checkoutReturns: string[] = [];
		const prepaidOwners: string[] = [];
		const portalOwners: string[] = [];
		let role = "admin";
		let membershipStatus = "active";
		const workos = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input) => {
				const url = new URL(String(input));
				expect(url.origin).toBe("https://api.workos.com");
				if (url.pathname.startsWith("/organizations/")) {
					const id = url.pathname.split("/").at(-1);
					return Response.json({ id, name: `Team ${id}` });
				}
				return Response.json({
					data: [
						{
							id: "member_a",
							user_id: url.searchParams.get("user_id"),
							organization_id: url.searchParams.get("organization_id"),
							status: membershipStatus,
							role: { slug: role },
						},
					],
					list_metadata: { after: null },
				});
			});
		const billing: BillingProviderAdapter = {
			providerId: "billing-test",
			checkout: (input) => {
				checkoutOwners.push(input.accountId);
				checkoutReturns.push(input.successUrl);
				return Effect.succeed("https://billing.test/checkout");
			},
			customerPortal: (owner) => {
				portalOwners.push(owner);
				return Effect.succeed("https://billing.test/portal");
			},
			prepaidCheckout: (input) => {
				prepaidOwners.push(input.accountId);
				return Effect.succeed("https://billing.test/credits");
			},
			getCheckout: () => Effect.succeed(null),
			verifyEvent: () => Effect.die("unused"),
			reconcileSubscription: () => Effect.die("unused"),
			cancel: () => Effect.void,
		};
		const billingApi = makeApi(
			await makeLayer(
				undefined,
				BillingProviders.layer({
					adapters: [billing],
					defaultProviderId: billing.providerId,
				}).pipe(Layer.orDie),
				true,
				{},
				SandboxProvidersFake,
				undefined,
				true,
			),
		);
		const call = (
			path: string,
			scope: string,
			body?: unknown,
			actor = "user_a",
		) =>
			billingApi.fetch(
				new Request(
					`${API_ISSUER}${scope.startsWith("organization:") ? `${WORKSPACE_API_PREFIX}${scope.slice(13)}` : ""}${path}`,
					{
						method: "POST",
						headers: {
							authorization: `Bearer test-token:${actor}`,
							"content-type": "application/json",
							[WORKSPACE_SCOPE_HEADER]: scope,
						},
						body: body === undefined ? undefined : JSON.stringify(body),
					},
				),
			);
		try {
			for (const scope of [
				"personal",
				"organization:org_a",
				"organization:org_b",
			]) {
				expect(
					(
						await call(ApiPaths.billingCheckout, scope, {
							offerId: CLOUD_WORKSPACE_OFFER_ID,
						})
					).status,
				).toBe(200);
				expect((await call(ApiPaths.billingPortal, scope)).status).toBe(200);
				expect(
					(
						await call(ApiPaths.billingPrepaidCheckout, scope, {
							amountCents: 2500,
						})
					).status,
				).toBe(200);
				const receipt = await billingApi.fetch(
					new Request(checkoutReturns.at(-1) ?? ""),
				);
				expect(await receipt.text()).toContain(
					scope === "personal"
						? ">Personal</span>"
						: `>Team ${scope.slice(13)}</span>`,
				);
			}
			expect(checkoutOwners).toEqual([
				"user_a",
				"organization:org_a",
				"organization:org_b",
			]);
			expect(portalOwners).toEqual(checkoutOwners);
			expect(prepaidOwners).toEqual(checkoutOwners);
			role = "member";
			expect(
				(
					await call(ApiPaths.billingPrepaidCheckout, "organization:org_a", {
						amountCents: 2500,
					})
				).status,
			).toBe(403);
			expect(
				(
					await call(ApiPaths.billingCheckout, "organization:org_a", {
						offerId: CLOUD_WORKSPACE_OFFER_ID,
					})
				).status,
			).toBe(403);
			expect(
				(await call(ApiPaths.billingPortal, "organization:org_a")).status,
			).toBe(403);
			expect(checkoutOwners).toHaveLength(3);
			expect(portalOwners).toHaveLength(3);
			role = "billing";
			expect(
				(
					await call(
						ApiPaths.billingPortal,
						"organization:org_a",
						undefined,
						"user_finance",
					)
				).status,
			).toBe(200);
			expect(portalOwners.at(-1)).toBe("organization:org_a");
			expect(
				(
					await call(
						ApiPaths.billingCheckout,
						"organization:org_a",
						{
							offerId: CLOUD_WORKSPACE_OFFER_ID,
						},
						"user_finance",
					)
				).status,
			).toBe(200);
			expect(checkoutOwners.at(-1)).toBe("organization:org_a");
			membershipStatus = "inactive";
			expect(
				(
					await call(
						ApiPaths.billingPortal,
						"organization:org_a",
						undefined,
						"user_finance",
					)
				).status,
			).toBe(403);
			expect(portalOwners).toHaveLength(4);
		} finally {
			workos.mockRestore();
			await billingApi.dispose();
		}
	});

	test("members can discover funded organization agents without credential-administration metadata", async () => {
		let role = "member";
		let status = "active";
		const workos = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			Response.json({
				data: [
					{
						id: "membership_a",
						user_id: "user_a",
						organization_id: "org_a",
						status,
						role: { slug: role },
					},
				],
				list_metadata: { after: null },
			}),
		);
		const fullStatus = CloudAuthStatus.make({
			authorityState: "ready",
			providers: [
				{
					providerId: "codex",
					state: "connected",
					accountLabel: "private-owner@example.test",
					method: "subscription",
					verifiedAt: 123,
					errorCode: "private-diagnostic",
				},
			],
			encryptionKeyId: "authority-key",
			encryptionPublicJwk: "authority-jwk",
			updatedAt: 123,
		});
		const authStatus = vi
			.spyOn(CloudAuthAuthority, "cloudAuthStatus")
			.mockReturnValue(Effect.succeed(fullStatus));
		const scopedApi = makeApi(
			await makeLayer(
				undefined,
				BillingProvidersManual,
				false,
				{ allowlistedAccountIds: new Set(["organization:org_a", "user_a"]) },
				SandboxProvidersFake,
				undefined,
				true,
			),
		);
		const call = (
			path: string = ApiPaths.cloudAuth,
			method = "GET",
			scope = "organization:org_a",
		) =>
			scopedApi.fetch(
				new Request(
					`${API_ISSUER}${scope === "personal" ? "" : `${WORKSPACE_API_PREFIX}${scope.slice(13)}`}${path}`,
					{
						method,
						headers: {
							authorization: "Bearer test-token:user_a",
							[WORKSPACE_SCOPE_HEADER]: scope,
						},
					},
				),
			);
		try {
			const response = await call();
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				authorityState: "ready",
				providers: [{ providerId: "codex", state: "connected" }],
			});
			expect(authStatus).toHaveBeenLastCalledWith("organization:org_a");
			for (const [path, method] of [
				[ApiPaths.cloudAuthProvision, "POST"],
				[ApiPaths.cloudAuthConfigure, "POST"],
				[ApiPaths.cloudAuthLoginStart, "POST"],
				[ApiPaths.cloudAuthLoginPoll("operation_a"), "GET"],
				[ApiPaths.cloudAuthDisconnect("codex"), "DELETE"],
			])
				expect((await call(path, method)).status).toBe(403);
			expect(
				(await call(ApiPaths.cloudAuth, "GET", "organization:org_b")).status,
			).toBe(403);
			role = "billing";
			expect((await call()).status).toBe(403);
			role = "member";
			status = "inactive";
			expect((await call()).status).toBe(403);
			expect(authStatus).toHaveBeenCalledTimes(1);
			status = "active";
			role = "admin";
			expect(await (await call()).json()).toEqual(fullStatus);
			expect(
				await (await call(ApiPaths.cloudAuth, "GET", "personal")).json(),
			).toEqual(fullStatus);
			expect(authStatus).toHaveBeenLastCalledWith("user_a");
		} finally {
			authStatus.mockRestore();
			workos.mockRestore();
			await scopedApi.dispose();
		}
	});

	test("isolates repository configuration and idempotency keys across Personal and organizations", async () => {
		let role = "admin";
		const workos = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input) => {
				const url = new URL(String(input));
				expect(url.origin).toBe("https://api.workos.com");
				return Response.json({
					data: [
						{
							id: "membership",
							user_id: "user_a",
							organization_id: url.searchParams.get("organization_id"),
							status: "active",
							role: { slug: role },
						},
					],
					list_metadata: { after: null },
				});
			});
		const scopedApi = makeApi(
			await makeLayer(
				undefined,
				BillingProvidersManual,
				false,
				{
					allowlistedAccountIds: new Set([
						"user_a",
						"organization:org_a",
						"organization:org_b",
					]),
				},
				SandboxProvidersFake,
				undefined,
				true,
			),
		);
		const call = (scope: string, method = "GET", projectId?: string) =>
			scopedApi.fetch(
				new Request(
					`${API_ISSUER}${scope === "personal" ? "" : `${WORKSPACE_API_PREFIX}${scope.slice(13)}`}${projectId ? ApiPaths.cloudProject(projectId) : ApiPaths.cloudProjects}`,
					{
						method,
						headers: {
							authorization: "Bearer test-token:user_a",
							"content-type": "application/json",
							[WORKSPACE_SCOPE_HEADER]: scope,
						},
						body:
							method === "POST"
								? JSON.stringify({
										repositoryUrl: "https://github.com/acme/app",
										defaultBranch: "main",
										visibility: "public",
										idempotencyKey: "same-intent",
									})
								: undefined,
					},
				),
			);
		try {
			const ids: string[] = [];
			for (const scope of [
				"personal",
				"organization:org_a",
				"organization:org_b",
			]) {
				const empty = await call(scope);
				expect(empty.status).toBe(200);
				expect(await empty.json()).toEqual({ projects: [] });
				const created = await call(scope, "POST");
				expect(created.status).toBe(201);
				const project = (await created.json()) as { projectId: string };
				ids.push(project.projectId);
				const duplicate = await call(scope, "POST");
				expect(await duplicate.json()).toMatchObject({
					projectId: project.projectId,
				});
			}
			expect(new Set(ids).size).toBe(3);
			expect((await call("organization:org_b", "DELETE", ids[1])).status).toBe(
				404,
			);
			expect((await call("organization:org_a", "DELETE", ids[0])).status).toBe(
				404,
			);
			role = "member";
			const memberProjects = await call("organization:org_a");
			expect(memberProjects.status).toBe(200);
			expect(await memberProjects.json()).toMatchObject({
				projects: [{ projectId: ids[1] }],
			});
			expect((await call("organization:org_a", "POST")).status).toBe(403);
			expect((await call("organization:org_a", "DELETE", ids[1])).status).toBe(
				403,
			);
			role = "billing";
			expect((await call("organization:org_a")).status).toBe(403);
			expect((await call("organization:org_a", "POST")).status).toBe(403);
		} finally {
			workos.mockRestore();
			await scopedApi.dispose();
		}
	});

	test("does not discover or connect another owner's host through legacy sharing metadata", async () => {
		const environmentId = "shared-host";
		const { credential } = await linkEnvironment({
			account: "user_a",
			environmentId,
		});
		const published = await api.fetch(
			new Request(`${API_ISSUER}/v1/environments/${environmentId}/heartbeat`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${credential}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					sharingAudience: [
						{
							organizationId: "org",
							membershipId: "member-b",
							subject: "user_b",
							adminOnly: false,
						},
					],
				}),
			}),
		);
		expect(published.status).toBe(200);
		const listed = await api.fetch(
			new Request(`${API_ISSUER}/v1/environments`, {
				headers: { authorization: "Bearer test-token:user_b" },
			}),
		);
		expect((await listed.json()).environments).toEqual([]);
		const device = (await ec()) as KeyPair;
		const jwk = await exportJWK(device.publicKey);
		const access = await mintAccess("user_b", device, jwk);
		for (const action of ["connect", "status"]) {
			const url = `${API_ISSUER}/v1/environments/${environmentId}/${action}`;
			const response = await api.fetch(
				new Request(url, {
					method: "POST",
					headers: {
						authorization: `DPoP ${access}`,
						dpop: await dpopProof(device, jwk, { method: "POST", url }),
					},
				}),
			);
			expect(response.status).toBe(404);
		}
	});
	test("serves the GitHub App callback without a WorkOS bearer", async () => {
		const response = await api.fetch(
			new Request(`${API_ISSUER}/v1/cloud/github/callback?installation_id=123`),
		);

		expect(response.status).toBe(400);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(await response.text()).toContain(
			"GitHub authorization is not configured on this deployment.",
		);

		const invalidState = await api.fetch(
			new Request(
				`${API_ISSUER}/v1/cloud/github/callback?installation_id=123&state=invalid`,
			),
		);
		expect(invalidState.status).toBe(400);
		expect(await invalidState.text()).toContain(
			"GitHub could not be connected",
		);
	});

	test("offers each server-owned cloud machine and makes creation idempotent", async () => {
		const headers = {
			authorization: "Bearer test-token:user_a",
			"content-type": "application/json",
		};
		const offers = await api.fetch(
			new Request(`${API_ISSUER}/v1/machine-offers`, { headers }),
		);
		expect(offers.status).toBe(200);
		expect(await offers.json()).toMatchObject({
			offers: [
				{
					offerId: "persistent-standard-v1",
					kind: "persistent",
					vcpuCount: 4,
					memoryMib: 8192,
					diskGib: 80,
					location: "Germany",
					monthlyPriceCents: 1900,
				},
			],
		});

		const create = () =>
			api.fetch(
				new Request(`${API_ISSUER}/v1/machines`, {
					method: "POST",
					headers,
					body: JSON.stringify({
						offerId: "persistent-standard-v1",
						label: "Build box",
						idempotencyKey: "create-once",
					}),
				}),
			);
		const first = await create();
		const second = await create();
		expect(first.status).toBe(201);
		expect(second.status).toBe(200);
		const firstBody = (await first.json()) as { machineId: string };
		const secondBody = (await second.json()) as { machineId: string };
		expect(first.headers.get("x-zuse-reconcile-machine")).toBe(
			firstBody.machineId,
		);
		expect(second.headers.get("x-zuse-reconcile-machine")).toBe(
			firstBody.machineId,
		);
		expect(secondBody.machineId).toBe(firstBody.machineId);

		const list = await api.fetch(
			new Request(`${API_ISSUER}/v1/machines`, { headers }),
		);
		const listBody = await list.json();
		expect(JSON.stringify(listBody)).not.toContain("providerServerId");
		expect(JSON.stringify(listBody)).not.toContain("lastError");

		const another = await api.fetch(
			new Request(`${API_ISSUER}/v1/machines`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					offerId: "persistent-standard-v1",
					idempotencyKey: "another-machine",
				}),
			}),
		);
		expect(another.status).toBe(409);
		expect(await another.json()).toEqual({ error: "machine_limit_reached" });
	});

	test("keeps live checkout disabled during manual-entitlement alpha", async () => {
		const response = await api.fetch(
			new Request(`${API_ISSUER}/v1/billing/checkout`, {
				method: "POST",
				headers: {
					authorization: "Bearer test-token:user_a",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					offerId: "persistent-standard-v1",
				}),
			}),
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "billing_approval_pending",
		});
	});

	test("prepaid endpoints authenticate, validate amounts and use the default provider without requiring a subscription", async () => {
		const purchases = vi.fn((_input: unknown) =>
			Effect.succeed("https://billing.test/credits"),
		);
		const subscription = vi.fn(() =>
			Effect.die("must not reconcile subscription for credits"),
		);
		const billing: BillingProviderAdapter = {
			providerId: "stripe",
			checkout: () => Effect.die("unused"),
			getCheckout: () => Effect.succeed(null),
			cancel: () => Effect.void,
			customerPortal: () => Effect.die("unused"),
			verifyEvent: () =>
				Effect.succeed({ eventId: "evt_credit", prepaid: true as const }),
			reconcileSubscription: subscription,
			prepaidBalance: (account) =>
				Effect.succeed({
					available: true,
					creditCents: account === "user_a" ? 7500 : 0,
					debitCents: 0,
					currency: "usd" as const,
				}),
			prepaidCheckout: purchases,
		};
		const billingApi = makeApi(
			await makeLayer(
				undefined,
				BillingProviders.layer({
					adapters: [billing],
					defaultProviderId: "stripe",
				}).pipe(Layer.orDie),
				true,
			),
		);
		const headers = {
			authorization: "Bearer test-token:user_a",
			"content-type": "application/json",
		};
		try {
			expect(
				(
					await billingApi.fetch(
						new Request(`${API_ISSUER}${ApiPaths.billingPrepaid}`),
					)
				).status,
			).toBe(401);
			const balance = await billingApi.fetch(
				new Request(`${API_ISSUER}${ApiPaths.billingPrepaid}`, { headers }),
			);
			expect(await balance.json()).toMatchObject({
				available: true,
				creditCents: 7500,
			});
			const buy = (amountCents: number) =>
				billingApi.fetch(
					new Request(`${API_ISSUER}${ApiPaths.billingPrepaidCheckout}`, {
						method: "POST",
						headers,
						body: JSON.stringify({ amountCents, accountId: "user_b" }),
					}),
				);
			expect((await buy(2501)).status).toBe(400);
			expect(purchases).not.toHaveBeenCalled();
			expect((await buy(2500)).status).toBe(200);
			expect(purchases).toHaveBeenCalledWith({
				accountId: "user_a",
				amountCents: 2500,
				successUrl: `${API_ISSUER}${ApiPaths.billingPrepaidComplete}`,
			});
			const webhook = await billingApi.fetch(
				new Request(
					`${API_ISSUER}${ApiPaths.billingProviderWebhook("stripe")}`,
					{ method: "POST" },
				),
			);
			expect(await webhook.json()).toEqual({ ok: true, prepaid: true });
			expect(subscription).not.toHaveBeenCalled();
			const completion = await billingApi.fetch(
				new Request(`${API_ISSUER}${ApiPaths.billingPrepaidComplete}`),
			);
			expect(completion.status).toBe(200);
			expect(await completion.text()).toContain("once payment is confirmed");
		} finally {
			await billingApi.dispose();
		}
	});

	test("manual billing never sells unusable prepaid credit", async () => {
		const headers = {
			authorization: "Bearer test-token:user_a",
			"content-type": "application/json",
		};
		const balance = await api.fetch(
			new Request(`${API_ISSUER}${ApiPaths.billingPrepaid}`, { headers }),
		);
		expect(await balance.json()).toEqual({
			available: false,
			creditCents: 0,
			debitCents: 0,
			currency: "usd",
		});
		const checkout = await api.fetch(
			new Request(`${API_ISSUER}${ApiPaths.billingPrepaidCheckout}`, {
				method: "POST",
				headers,
				body: JSON.stringify({ amountCents: 2500 }),
			}),
		);
		expect(checkout.status).toBe(503);
	});

	test("creates checkout with the api-owned HTTPS completion page", async () => {
		let checkoutInput:
			| {
					readonly accountId: string;
					readonly offerId: string;
					readonly successUrl: string;
			  }
			| undefined;
		let checkoutLookups: ReadonlyArray<{
			readonly checkoutId: string;
			readonly accountId: string;
		}> = [];
		const billing: BillingProviderAdapter = {
			providerId: "billing-test",
			checkout: (input) => {
				checkoutInput = input;
				return Effect.succeed("https://billing.test/checkout");
			},
			// Mirrors a real adapter: the checkout belongs to `user_a` only.
			getCheckout: (input) => {
				checkoutLookups = [...checkoutLookups, input];
				return Effect.succeed(
					input.accountId === "user_a"
						? {
								amountCents: 1_900,
								checkoutId: input.checkoutId,
								createdAtMs: Date.parse("2026-08-14T10:11:12.000Z"),
								currency: "usd",
								productName: "Persistent Standard",
								status: "paid" as const,
							}
						: null,
				);
			},
			verifyEvent: () => Effect.die("unused"),
			reconcileSubscription: () => Effect.die("unused"),
			cancel: () => Effect.void,
			customerPortal: () => Effect.succeed("https://billing.test/portal"),
		};
		const billingApi = makeApi(
			await makeLayer(
				undefined,
				BillingProviders.layer({
					adapters: [billing],
					defaultProviderId: billing.providerId,
				}).pipe(Layer.orDie),
				true,
			),
		);

		try {
			const response = await billingApi.fetch(
				new Request(`${API_ISSUER}${ApiPaths.billingCheckout}`, {
					method: "POST",
					headers: {
						authorization: "Bearer test-token:user_a",
						"content-type": "application/json",
					},
					body: JSON.stringify({ offerId: "persistent-standard-v1" }),
				}),
			);

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				checkoutUrl: "https://billing.test/checkout",
			});
			expect(checkoutInput).toMatchObject({
				accountId: "user_a",
				offerId: "persistent-standard-v1",
			});
			const successUrl = new URL(checkoutInput?.successUrl ?? "");
			expect(`${successUrl.origin}${successUrl.pathname}`).toBe(
				`${API_ISSUER}${ApiPaths.billingCheckoutComplete}`,
			);
			expect(successUrl.searchParams.get("offer")).toBe(
				"persistent-standard-v1",
			);
			// The provider interpolates this itself, so it must not be encoded.
			expect(checkoutInput?.successUrl).toContain("&checkout_id={CHECKOUT_ID}");
			const receiptTicket = successUrl.searchParams.get("t") ?? "";
			expect(receiptTicket.length).toBeGreaterThan(0);

			const completeUrl = (params: Record<string, string>): string => {
				const target = new URL(
					`${API_ISSUER}${ApiPaths.billingCheckoutComplete}`,
				);
				for (const [key, value] of Object.entries(params)) {
					target.searchParams.set(key, value);
				}
				return target.toString();
			};

			const completion = await billingApi.fetch(
				new Request(
					completeUrl({
						checkout_id: "checkout_abcdef123456",
						t: receiptTicket,
						workspaceName: "Untrusted organization",
					}),
				),
			);
			const completionPage = await completion.text();
			expect(completion.status).toBe(200);
			expect(completion.headers.get("content-type")).toContain("text/html");
			expect(completion.headers.get("cache-control")).toBe("no-store");
			expect(checkoutLookups).toEqual([
				{ accountId: "user_a", checkoutId: "checkout_abcdef123456" },
			]);
			expect(completionPage).toContain("Persistent Standard");
			expect(completionPage).toContain(">Personal</span>");
			expect(completionPage).not.toContain("Untrusted organization");
			expect(completionPage).toContain("$19.00");
			expect(completionPage).toContain("Paid");

			// Without the api-signed ticket nothing is looked up at all, so a
			// stolen checkout id discloses nothing.
			const unticketed = await billingApi.fetch(
				new Request(completeUrl({ checkout_id: "checkout_abcdef123456" })),
			);
			const unticketedPage = await unticketed.text();
			expect(unticketed.status).toBe(200);
			expect(checkoutLookups).toHaveLength(1);
			expect(unticketedPage).toContain("Awaiting confirmation");
			expect(unticketedPage).not.toContain("ZS-EF123456");

			// A forged or expired ticket is treated the same as none.
			const forged = await billingApi.fetch(
				new Request(
					completeUrl({
						checkout_id: "checkout_abcdef123456",
						t: `${receiptTicket.slice(0, -4)}AAAA`,
					}),
				),
			);
			expect(forged.status).toBe(200);
			expect(checkoutLookups).toHaveLength(1);
			expect(await forged.text()).toContain("Awaiting confirmation");

			// An unsubstituted placeholder must not be looked up, and the page still
			// names the purchase from the ticket's offer.
			const placeholderCompletion = await billingApi.fetch(
				new Request(
					completeUrl({ checkout_id: "{CHECKOUT_ID}", t: receiptTicket }),
				),
			);
			const placeholderPage = await placeholderCompletion.text();
			expect(placeholderCompletion.status).toBe(200);
			expect(checkoutLookups).toHaveLength(1);
			expect(placeholderPage).toContain("Persistent Standard");
			expect(placeholderPage).toContain("Awaiting confirmation");
		} finally {
			await billingApi.dispose();
		}
	});

	test("keeps the completion page useful when the billing lookup fails", async () => {
		let successUrl = "";
		const billing: BillingProviderAdapter = {
			providerId: "billing-test",
			checkout: (input) => {
				successUrl = input.successUrl;
				return Effect.succeed("https://billing.test/checkout");
			},
			getCheckout: () =>
				new BillingProviderError({ code: "provider-unavailable" }),
			verifyEvent: () => Effect.die("unused"),
			reconcileSubscription: () => Effect.die("unused"),
			cancel: () => Effect.void,
			customerPortal: () => Effect.succeed("https://billing.test/portal"),
		};
		const billingApi = makeApi(
			await makeLayer(
				undefined,
				BillingProviders.layer({
					adapters: [billing],
					defaultProviderId: billing.providerId,
				}).pipe(Layer.orDie),
				true,
			),
		);

		try {
			await billingApi.fetch(
				new Request(`${API_ISSUER}${ApiPaths.billingCheckout}`, {
					method: "POST",
					headers: {
						authorization: "Bearer test-token:user_a",
						"content-type": "application/json",
					},
					body: JSON.stringify({ offerId: "persistent-standard-v1" }),
				}),
			);
			const ticket = new URL(successUrl).searchParams.get("t") ?? "";
			const completion = await billingApi.fetch(
				new Request(
					`${API_ISSUER}${ApiPaths.billingCheckoutComplete}?checkout_id=checkout_abcdef123456&t=${encodeURIComponent(ticket)}`,
				),
			);
			const page = await completion.text();
			expect(completion.status).toBe(200);
			expect(page).toContain("Persistent Standard");
			expect(page).toContain("Awaiting confirmation");

			// Unknown offers are never echoed back into the page.
			const hostile = await billingApi.fetch(
				new Request(
					`${API_ISSUER}${ApiPaths.billingCheckoutComplete}?offer=${encodeURIComponent("<script>alert(1)</script>")}`,
				),
			);
			const hostilePage = await hostile.text();
			expect(hostile.status).toBe(200);
			expect(hostilePage).not.toContain("<script>alert");
			expect(hostilePage).toContain("Zuse subscription");
		} finally {
			await billingApi.dispose();
		}
	});

	test("new subscriptions use Stripe while existing Polar subscriptions retain their portal and block duplicate checkout", async () => {
		const stripeBalance = vi.fn(() =>
			Effect.succeed({
				available: true,
				creditCents: 0,
				debitCents: 0,
				currency: "usd" as const,
			}),
		);
		const stripeCredits = vi.fn(() =>
			Effect.succeed("https://stripe.test/credits"),
		);
		const checkout = vi.fn(() =>
			Effect.succeed("https://stripe.test/checkout"),
		);
		const polarPortal = vi.fn(() =>
			Effect.succeed("https://polar.test/portal"),
		);
		const polar: BillingProviderAdapter = {
			providerId: "polar",
			checkout: () => Effect.die("new checkout must use Stripe"),
			getCheckout: () => Effect.succeed(null),
			cancel: () => Effect.void,
			customerPortal: polarPortal,
			verifyEvent: () =>
				Effect.succeed({ eventId: "polar-event", subscriptionId: "polar-sub" }),
			reconcileSubscription: () =>
				Effect.succeed({
					accountId: "user_b",
					providerSubscriptionId: "polar-sub",
					status: "active",
					offerId: CLOUD_WORKSPACE_OFFER_ID,
					periodStart: Date.now() - 60_000,
					paidThrough: Date.now() + 86_400_000,
				}),
		};
		const stripe: BillingProviderAdapter = {
			...polar,
			providerId: "stripe",
			checkout,
			prepaidBalance: stripeBalance,
			prepaidCheckout: stripeCredits,
			customerPortal: () => Effect.die("legacy portal must use Polar"),
		};
		const billingApi = makeApi(
			await makeLayer(
				undefined,
				BillingProviders.layer({
					adapters: [polar, stripe],
					defaultProviderId: "stripe",
				}).pipe(Layer.orDie),
				true,
			),
		);
		const requestCheckout = (account: string) =>
			billingApi.fetch(
				new Request(`${API_ISSUER}${ApiPaths.billingCheckout}`, {
					method: "POST",
					headers: {
						authorization: `Bearer test-token:${account}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ offerId: CLOUD_WORKSPACE_OFFER_ID }),
				}),
			);
		try {
			const delivery = await billingApi.fetch(
				new Request(`${API_ISSUER}/v1/billing/webhook/polar`, {
					method: "POST",
					body: "{}",
				}),
			);
			expect(delivery.status).toBe(200);
			const purchase = await requestCheckout("user_a");
			expect(purchase.status).toBe(200);
			expect(await purchase.json()).toEqual({
				checkoutUrl: "https://stripe.test/checkout",
			});
			expect(checkout).toHaveBeenCalledTimes(1);
			const portal = await billingApi.fetch(
				new Request(`${API_ISSUER}${ApiPaths.billingPortal}`, {
					method: "POST",
					headers: { authorization: "Bearer test-token:user_b" },
				}),
			);
			expect(portal.status).toBe(200);
			expect(await portal.json()).toEqual({
				portalUrl: "https://polar.test/portal",
			});
			expect(polarPortal).toHaveBeenCalledWith("user_b");
			const balance = await billingApi.fetch(
				new Request(`${API_ISSUER}${ApiPaths.billingPrepaid}`, {
					headers: { authorization: "Bearer test-token:user_b" },
				}),
			);
			expect(balance.status).toBe(200);
			expect(await balance.json()).toMatchObject({ available: false });
			expect(stripeBalance).not.toHaveBeenCalled();
			const credits = await billingApi.fetch(
				new Request(`${API_ISSUER}${ApiPaths.billingPrepaidCheckout}`, {
					method: "POST",
					headers: {
						authorization: "Bearer test-token:user_b",
						"content-type": "application/json",
					},
					body: JSON.stringify({ amountCents: 2500 }),
				}),
			);
			expect(credits.status).toBe(503);
			expect(stripeCredits).not.toHaveBeenCalled();
			expect((await requestCheckout("user_b")).status).toBe(409);
			expect(checkout).toHaveBeenCalledTimes(1);
		} finally {
			await billingApi.dispose();
		}
	});

	test("creates cloud workspace entitlement checkout without provider placement", async () => {
		let checkoutInput:
			| Parameters<BillingProviderAdapter["checkout"]>[0]
			| undefined;
		const billing: BillingProviderAdapter = {
			providerId: "billing-test",
			checkout: (input) => {
				checkoutInput = input;
				return Effect.succeed("https://billing.test/sandbox-checkout");
			},
			getCheckout: () => Effect.succeed(null),
			verifyEvent: () => Effect.die("unused"),
			reconcileSubscription: () => Effect.die("unused"),
			cancel: () => Effect.void,
			customerPortal: () => Effect.succeed("https://billing.test/portal"),
		};
		const billingApi = makeApi(
			await makeLayer(
				undefined,
				BillingProviders.layer({
					adapters: [billing],
					defaultProviderId: billing.providerId,
				}).pipe(Layer.orDie),
				true,
			),
		);

		try {
			const response = await billingApi.fetch(
				new Request(`${API_ISSUER}${ApiPaths.billingCheckout}`, {
					method: "POST",
					headers: {
						authorization: "Bearer test-token:user_a",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						offerId: "cloud-workspace-standard-v1",
					}),
				}),
			);

			expect(response.status).toBe(200);
			expect(checkoutInput).toMatchObject({
				accountId: "user_a",
				offerId: "cloud-workspace-standard-v1",
			});
			expect(checkoutInput).not.toHaveProperty("fulfillmentMetadata");
		} finally {
			await billingApi.dispose();
		}
	});

	test("unclaimed webhooks do not block delivery and expired access reconciles on read", async () => {
		let linked = false;
		let accountId = "user_a";
		let unavailable = false;
		let valid = true;
		let paidThrough = Date.now() - 60_000;
		let periodStart = paidThrough - 86_400_000;
		const billing: BillingProviderAdapter = {
			providerId: "billing-test",
			checkout: () => Effect.succeed("https://billing.test/checkout"),
			getCheckout: () => Effect.succeed(null),
			verifyEvent: () =>
				valid
					? Effect.succeed({
							eventId: "renewal-event",
							subscriptionId: "renewal-subscription",
						})
					: Effect.fail(new BillingProviderError({ code: "invalid-event" })),
			reconcileSubscription: (subscriptionId) =>
				unavailable
					? Effect.fail(
							new BillingProviderError({ code: "provider-unavailable" }),
						)
					: !linked
						? Effect.fail(
								new BillingProviderError({ code: "subscription-unlinked" }),
							)
						: Effect.succeed({
								accountId,
								providerSubscriptionId: subscriptionId,
								periodStart,
								status: "active",
								offerId: "cloud-workspace-standard-v1",
								paidThrough,
							}),
			cancel: () => Effect.void,
			customerPortal: () => Effect.succeed("https://billing.test/portal"),
		};
		const billingApi = makeApi(
			await makeLayer(
				undefined,
				BillingProviders.layer({
					adapters: [billing],
					defaultProviderId: billing.providerId,
				}).pipe(Layer.orDie),
				true,
			),
		);
		const deliver = () =>
			billingApi.fetch(
				new Request(`${API_ISSUER}/v1/billing/webhook/billing-test`, {
					method: "POST",
					body: "{}",
				}),
			);
		const entitlements = () =>
			billingApi.fetch(
				new Request(`${API_ISSUER}${ApiPaths.billingEntitlements}`, {
					headers: { authorization: "Bearer test-token:user_a" },
				}),
			);
		try {
			const deferred = await deliver();
			expect(deferred.status).toBe(200);
			expect(await deferred.json()).toEqual({
				ok: true,
				deferred: "subscription-unlinked",
			});
			expect(await (await entitlements()).json()).toEqual({ entitlements: [] });
			unavailable = true;
			expect((await deliver()).status).toBe(503);
			unavailable = false;
			valid = false;
			expect((await deliver()).status).toBe(401);
			valid = true;
			linked = true;
			// The deferred delivery must not deduplicate away a later linked delivery.
			expect((await deliver()).status).toBe(200);
			periodStart = Date.now() - 30_000;
			paidThrough = Date.now() + 86_400_000;
			unavailable = true;
			expect((await entitlements()).status).toBe(503);
			unavailable = false;
			accountId = "user_other";
			expect((await entitlements()).status).toBe(503);
			accountId = "user_a";
			const refreshed = await entitlements();
			expect(refreshed.status).toBe(200);
			expect(await refreshed.json()).toMatchObject({
				entitlements: [{ status: "active", paidThrough }],
			});
			const summary = await billingApi.fetch(
				new Request(`${API_ISSUER}${ApiPaths.cloudBillingSummary}`, {
					headers: { authorization: "Bearer test-token:user_a" },
				}),
			);
			expect(summary.status).toBe(200);
			expect(await summary.json()).toMatchObject({
				periodStart,
				periodEnd: paidThrough,
			});
		} finally {
			await billingApi.dispose();
		}
	});

	test("reconciles an ended subscription before offering replacement checkout", async () => {
		let status: "active" | "ended" = "active";
		const billing: BillingProviderAdapter = {
			providerId: "billing-test",
			checkout: () => Effect.succeed("https://billing.test/replacement"),
			getCheckout: () => Effect.succeed(null),
			verifyEvent: (request) =>
				Effect.promise(async () => {
					const body = (await request.json()) as {
						readonly eventId: string;
						readonly subscriptionId: string;
					};
					return body;
				}),
			reconcileSubscription: (subscriptionId) =>
				Effect.succeed({
					accountId: "user_a",
					providerSubscriptionId: subscriptionId,
					status,
					offerId: "persistent-standard-v1",
					paidThrough: Date.now() + 86_400_000,
				}),
			cancel: () => Effect.void,
			customerPortal: () => Effect.succeed("https://billing.test/portal"),
		};
		const billingApi = makeApi(
			await makeLayer(
				undefined,
				BillingProviders.layer({
					adapters: [billing],
					defaultProviderId: billing.providerId,
				}).pipe(Layer.orDie),
				true,
			),
		);

		try {
			const activated = await billingApi.fetch(
				new Request(`${API_ISSUER}/v1/billing/webhook/${billing.providerId}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						eventId: "replacement-active",
						subscriptionId: "replacement-subscription",
					}),
				}),
			);
			expect(activated.status).toBe(200);

			const listed = await billingApi.fetch(
				new Request(`${API_ISSUER}${ApiPaths.machines}`, {
					headers: { authorization: "Bearer test-token:user_a" },
				}),
			);
			const machine = (await listed.json()) as {
				readonly machines: ReadonlyArray<{ readonly machineId: string }>;
			};
			const machineId = machine.machines[0]?.machineId;
			expect(machineId).toBeDefined();

			const destroyed = await billingApi.fetch(
				new Request(
					`${API_ISSUER}${ApiPaths.machineDestroy(machineId ?? "")}`,
					{
						method: "POST",
						headers: {
							authorization: "Bearer test-token:user_a",
							"content-type": "application/json",
						},
						body: JSON.stringify({ machineId, confirmation: "destroy" }),
					},
				),
			);
			expect(destroyed.status).toBe(200);
			await billingApi.reconcile("replacement-destroy");

			status = "ended";
			const checkout = await billingApi.fetch(
				new Request(`${API_ISSUER}${ApiPaths.billingCheckout}`, {
					method: "POST",
					headers: {
						authorization: "Bearer test-token:user_a",
						"content-type": "application/json",
					},
					body: JSON.stringify({ offerId: "persistent-standard-v1" }),
				}),
			);

			expect(checkout.status).toBe(200);
			expect(await checkout.json()).toEqual({
				checkoutUrl: "https://billing.test/replacement",
			});
		} finally {
			await billingApi.dispose();
		}
	});

	test("deduplicates billing events and reconciles out-of-order delivery from authoritative state", async () => {
		let status: "active" | "ended" = "active";
		const billing: BillingProviderAdapter = {
			providerId: "billing-test",
			checkout: () => Effect.succeed("https://billing.test/checkout"),
			getCheckout: () => Effect.succeed(null),
			verifyEvent: (request) =>
				Effect.promise(async () => {
					const body = (await request.json()) as {
						readonly eventId: string;
						readonly subscriptionId: string;
					};
					return body;
				}),
			reconcileSubscription: (subscriptionId) =>
				Effect.sync(() => ({
					accountId: "user_a",
					providerSubscriptionId: subscriptionId,
					status,
					offerId: "persistent-standard-v1",
					paidThrough:
						status === "active" ? Date.now() + 86_400_000 : Date.now(),
				})),
			cancel: () => Effect.void,
			customerPortal: () => Effect.succeed("https://billing.test/portal"),
		};
		const defaultBilling: BillingProviderAdapter = {
			...billing,
			providerId: "billing-default",
			customerPortal: () => Effect.succeed("https://default.test/portal"),
		};
		const billingApi = makeApi(
			await makeLayer(
				undefined,
				BillingProviders.layer({
					adapters: [billing, defaultBilling],
					defaultProviderId: defaultBilling.providerId,
				}).pipe(Layer.orDie),
				false,
			),
		);
		const deliver = (eventId: string) =>
			billingApi.fetch(
				new Request(`${API_ISSUER}/v1/billing/webhook/${billing.providerId}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						eventId,
						subscriptionId: "subscription_1",
					}),
				}),
			);

		try {
			const first = await deliver("event_newer");
			const firstBody = (await first.json()) as {
				readonly machineId: string;
				readonly ok: boolean;
				readonly duplicate: boolean;
				readonly provisioningQueued: boolean;
			};
			const immediate = await billingApi.reconcileMachine(
				firstBody.machineId,
				"webhook-test",
			);
			const unqualified = await billingApi.fetch(
				new Request(`${API_ISSUER}/v1/billing/webhook`, {
					method: "POST",
				}),
			);
			const portal = await billingApi.fetch(
				new Request(`${API_ISSUER}/v1/billing/portal`, {
					method: "POST",
					headers: { authorization: "Bearer test-token:user_a" },
				}),
			);
			const duplicateCreate = await billingApi.fetch(
				new Request(`${API_ISSUER}/v1/machines`, {
					method: "POST",
					headers: {
						authorization: "Bearer test-token:user_a",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						offerId: "persistent-standard-v1",
						idempotencyKey: "billing-machine",
					}),
				}),
			);
			const duplicate = await deliver("event_newer");
			status = "ended";
			const outOfOrder = await deliver("event_older");
			const entitlements = await billingApi.fetch(
				new Request(`${API_ISSUER}/v1/billing/entitlements`, {
					headers: { authorization: "Bearer test-token:user_a" },
				}),
			);
			const machines = await billingApi.fetch(
				new Request(`${API_ISSUER}/v1/machines`, {
					headers: { authorization: "Bearer test-token:user_a" },
				}),
			);

			expect(firstBody).toMatchObject({
				ok: true,
				duplicate: false,
				provisioningQueued: true,
			});
			expect(immediate).toEqual({ claimed: 1, processed: 1 });
			expect(unqualified.status).toBe(400);
			expect(await portal.json()).toEqual({
				portalUrl: "https://billing.test/portal",
			});
			expect(duplicateCreate.status).toBe(409);
			expect(await duplicate.json()).toMatchObject({
				ok: true,
				duplicate: true,
				provisioningQueued: false,
			});
			expect(await outOfOrder.json()).toMatchObject({
				ok: true,
				duplicate: false,
				provisioningQueued: false,
			});
			expect(await entitlements.json()).toMatchObject({
				entitlements: [{ status: "ended" }],
			});
			expect(await machines.json()).toMatchObject({
				machines: [
					{
						desiredState: "suspended",
						statusCode: "cancellation-scheduled",
					},
				],
			});
		} finally {
			await billingApi.dispose();
		}
	});

	test("brokers browser PKCE token exchanges without exposing a general proxy", async () => {
		const response = await api.fetch(
			new Request(`${API_ISSUER}/v1/auth/token`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://code.zuse.sh",
				},
				body: JSON.stringify({
					grantType: "authorization_code",
					code: "test-code",
					codeVerifier: "v".repeat(43),
				}),
			}),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("access-control-allow-origin")).toBe(
			"https://code.zuse.sh",
		);
		expect(await response.json()).toEqual({
			access_token: "test-access-token",
			refresh_token: "test-refresh-token",
		});

		const refreshResponse = await api.fetch(
			new Request(`${API_ISSUER}/v1/auth/token`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://code.zuse.sh",
				},
				body: JSON.stringify({
					grantType: "refresh_token",
					refreshToken: "test-refresh-token",
				}),
			}),
		);

		expect(refreshResponse.status).toBe(200);
		expect(await refreshResponse.json()).toEqual({
			access_token: "test-access-token",
			refresh_token: "test-refresh-token-rotated",
		});
	});

	test("verifies DPoP against the public api URL behind a rewritten worker URL", async () => {
		const device = (await ec()) as KeyPair;
		const jwk = await exportJWK(device.publicKey);
		const publicUrl = `${API_ISSUER}/v1/client/dpop-token`;
		const response = await api.fetch(
			new Request("http://worker.internal/v1/client/dpop-token", {
				method: "POST",
				headers: {
					authorization: "Bearer test-token:user_proxy",
					dpop: await dpopProof(device, jwk, {
						method: "POST",
						url: publicUrl,
					}),
				},
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			accessToken: expect.any(String),
		});
	});

	test("binds DPoP to the configured public origin independently of the token issuer", async () => {
		const publicOrigin = "https://api-staging.zuse.sh";
		api = makeApi(
			await makeLayer(undefined, undefined, false, {}, undefined, publicOrigin),
		);
		const device = (await ec()) as KeyPair;
		const jwk = await exportJWK(device.publicKey);
		for (const origin of [API_ISSUER, "https://untrusted.test", publicOrigin]) {
			const response = await api.fetch(
				new Request("http://worker.internal/v1/client/dpop-token", {
					method: "POST",
					headers: {
						authorization: "Bearer test-token:user_public_origin",
						dpop: await dpopProof(device, jwk, {
							method: "POST",
							url: `${origin}/v1/client/dpop-token`,
						}),
						"x-forwarded-host": "untrusted.test",
					},
				}),
			);
			expect(response.status).toBe(origin === publicOrigin ? 200 : 401);
			if (origin !== publicOrigin) {
				expect(await response.json()).toMatchObject({
					error: "dpop_claims_mismatch",
				});
			} else {
				const { accessToken } = await response.json();
				const url = `${publicOrigin}/v1/mobile/devices`;
				const registered = await api.fetch(
					new Request(url, {
						method: "POST",
						headers: {
							authorization: `DPoP ${accessToken}`,
							dpop: await dpopProof(device, jwk, { method: "POST", url }),
							"content-type": "application/json",
						},
						body: JSON.stringify({
							deviceId: "phone_public_origin",
							platform: "ios",
							dpopJwk: jwk,
							expoPushToken: "ExponentPushToken[test]",
						}),
					}),
				);
				expect(registered.status).toBe(200);
			}
		}
	});
	test.each([
		ApiPaths.cloudSettings,
		ApiPaths.cloudSharingDefaults,
		ApiPaths.cloudWorkspaceSharing("workspace-a"),
	])("permits scoped browser PUT preflights for %s", async (path) => {
		const response = await api.fetch(
			new Request(`${API_ISSUER}${path}`, {
				method: "OPTIONS",
				headers: {
					origin: "https://code.zuse.sh",
					"access-control-request-method": "PUT",
					"access-control-request-headers": `authorization,content-type,${WORKSPACE_SCOPE_HEADER}`,
				},
			}),
		);
		expect(response.status).toBe(204);
		expect(
			response.headers.get("access-control-allow-methods")?.split(", "),
		).toContain("PUT");
		expect(response.headers.get("access-control-allow-headers")).toContain(
			WORKSPACE_SCOPE_HEADER,
		);
		expect(response.headers.get("access-control-allow-origin")).toBe(
			"https://code.zuse.sh",
		);
	});

	test("allows the hosted product origin without opening api CORS broadly", async () => {
		const allowed = await api.fetch(
			new Request(`${API_ISSUER}/v1/environments`, {
				method: "OPTIONS",
				headers: { origin: "https://code.zuse.sh" },
			}),
		);
		expect(allowed.status).toBe(204);
		expect(allowed.headers.get("access-control-allow-origin")).toBe(
			"https://code.zuse.sh",
		);

		const denied = await api.fetch(
			new Request(`${API_ISSUER}/v1/environments`, {
				method: "OPTIONS",
				headers: { origin: "https://untrusted.test" },
			}),
		);
		expect(denied.headers.get("access-control-allow-origin")).toBeNull();

		const legacy = await api.fetch(
			new Request(`${API_ISSUER}/v1/environments`, {
				method: "OPTIONS",
				headers: { origin: "https://app.zuse.sh" },
			}),
		);
		expect(legacy.headers.get("access-control-allow-origin")).toBeNull();
	});

	test("enforces the account computer limit without blocking an existing computer", async () => {
		api = makeApi(await makeLayer(undefined, 1));
		await linkEnvironment({
			account: "user_limit",
			environmentId: "env_first",
		});

		const second = await requestEnvironmentLink({
			account: "user_limit",
			environmentId: "env_second",
		});
		expect(second.response.status).toBe(409);
		expect(await second.response.json()).toEqual({
			error: "computer_limit_reached",
		});

		const same = await requestEnvironmentLink({
			account: "user_limit",
			environmentId: "env_first",
		});
		expect(same.response.status).toBe(200);
	});

	test("lists runtime and capability metadata without workspace content", async () => {
		await linkEnvironment({
			account: "user_metadata",
			environmentId: "env_metadata",
			runtimeVersion: "1.4.0",
		});
		const response = await api.fetch(
			new Request(`${API_ISSUER}/v1/environments`, {
				headers: { authorization: "Bearer test-token:user_metadata" },
			}),
		);
		const body = (await response.json()) as {
			environments: ReadonlyArray<Record<string, unknown>>;
		};
		expect(body.environments).toHaveLength(1);
		expect(body.environments[0]).toMatchObject({
			environmentId: "env_metadata",
			runtimeVersion: "1.4.0",
			serviceState: "healthy",
			capabilities: {
				version: 1,
				features: ["agents", "files", "terminals"],
			},
		});
		expect(JSON.stringify(body)).not.toContain("transcript");
		expect(JSON.stringify(body)).not.toContain("toolOutput");
	});

	test("lists and revokes one browser without affecting the account", async () => {
		await linkEnvironment({
			account: "user_clients",
			environmentId: "env_clients",
		});
		const device = (await ec()) as KeyPair;
		const jwk = await exportJWK(device.publicKey);
		const accessToken = await mintAccess("user_clients", device, jwk);
		const devicesUrl = `${API_ISSUER}/v1/mobile/devices`;
		const registered = await api.fetch(
			new Request(devicesUrl, {
				method: "POST",
				headers: {
					authorization: `DPoP ${accessToken}`,
					dpop: await dpopProof(device, jwk, {
						method: "POST",
						url: devicesUrl,
					}),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					deviceId: "browser_one",
					platform: "web",
					dpopJwk: jwk,
				}),
			}),
		);
		expect(registered.status).toBe(200);

		const listed = await api.fetch(
			new Request(`${API_ISSUER}/v1/clients`, {
				headers: { authorization: "Bearer test-token:user_clients" },
			}),
		);
		expect(await listed.json()).toMatchObject({
			clients: [{ clientId: "browser_one", platform: "web" }],
		});

		const revoked = await api.fetch(
			new Request(`${API_ISSUER}/v1/clients/browser_one`, {
				method: "DELETE",
				headers: { authorization: "Bearer test-token:user_clients" },
			}),
		);
		expect(revoked.status).toBe(200);

		const statusUrl = `${API_ISSUER}/v1/environments/env_clients/status`;
		const afterRevocation = await api.fetch(
			new Request(statusUrl, {
				method: "POST",
				headers: {
					authorization: `DPoP ${accessToken}`,
					dpop: await dpopProof(device, jwk, {
						method: "POST",
						url: statusUrl,
					}),
				},
			}),
		);
		expect(afterRevocation.status).toBe(401);
		expect(await afterRevocation.json()).toEqual({ error: "client_revoked" });
	});

	test("links an environment, reports presence, and mints a connect token", async () => {
		const { environmentId } = { environmentId: "env_1" };
		const { credential } = await linkEnvironment({
			account: "user_a",
			environmentId,
		});

		const device = (await ec()) as KeyPair;
		const jwk = await exportJWK(device.publicKey);
		const accessToken = await mintAccess("user_a", device, jwk);

		// Before any heartbeat: offline.
		const statusUrl = `${API_ISSUER}/v1/environments/${environmentId}/status`;
		const offline = await api.fetch(
			new Request(statusUrl, {
				method: "POST",
				headers: {
					authorization: `DPoP ${accessToken}`,
					dpop: await dpopProof(device, jwk, {
						method: "POST",
						url: statusUrl,
					}),
				},
			}),
		);
		expect((await offline.json()).status).toBe("offline");

		// Heartbeat → online.
		expect(
			(
				await heartbeat(environmentId, credential, {
					httpBaseUrl: "http://100.64.0.8:47837",
					wsBaseUrl: "ws://100.64.0.8:47837",
				})
			).status,
		).toBe(200);
		expect(
			(
				await heartbeat(environmentId, credential, {
					httpBaseUrl: "https://attacker.test",
					wsBaseUrl: "wss://attacker.test",
				})
			).status,
		).toBe(400);
		const online = await api.fetch(
			new Request(statusUrl, {
				method: "POST",
				headers: {
					authorization: `DPoP ${accessToken}`,
					dpop: await dpopProof(device, jwk, {
						method: "POST",
						url: statusUrl,
					}),
				},
			}),
		);
		expect((await online.json()).status).toBe("online");

		// Connect → signed token.
		const connectUrl = `${API_ISSUER}/v1/environments/${environmentId}/connect`;
		const connect = await api.fetch(
			new Request(connectUrl, {
				method: "POST",
				headers: {
					authorization: `DPoP ${accessToken}`,
					dpop: await dpopProof(device, jwk, {
						method: "POST",
						url: connectUrl,
					}),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					localPairing: {
						serverNonce: "discovery-nonce",
						devicePublicKey: "D".repeat(43),
						transportCertificatePin: "T".repeat(43),
					},
				}),
			}),
		);
		const connectBody = (await connect.json()) as {
			connectToken: string;
			endpointCandidates: ReadonlyArray<{ kind: string; wsBaseUrl: string }>;
		};
		expect(connectBody.connectToken.split(".")).toHaveLength(3); // a JWT, not base64 stub
		expect(connectBody.endpointCandidates[0]).toEqual({
			kind: "private-network",
			endpoint: {
				httpBaseUrl: "http://100.64.0.8:47837",
				wsBaseUrl: "ws://100.64.0.8:47837",
			},
		});
		const verified = await jwtVerify(
			connectBody.connectToken,
			await importJWK(await exportJWK(mintKey.publicKey), "EdDSA"),
			{ issuer: API_ISSUER, audience: `zuse-env:${environmentId}` },
		);
		expect(verified.payload.localPairing).toEqual({
			serverNonce: "discovery-nonce",
			devicePublicKey: "D".repeat(43),
			transportCertificatePin: "T".repeat(43),
		});
	});

	test("returns stable route and wire compatibility errors", async () => {
		const environmentId = "env_compatibility";
		await linkEnvironment({
			account: "user_compatibility",
			environmentId,
			wireProtocolVersion: 2,
		});
		const device = (await ec()) as KeyPair;
		const jwk = await exportJWK(device.publicKey);
		const accessToken = await mintAccess("user_compatibility", device, jwk);
		const connectUrl = `${API_ISSUER}/v1/environments/${environmentId}/connect`;

		const incompatibleRequest = new Request(connectUrl, {
			method: "POST",
			headers: {
				authorization: `DPoP ${accessToken}`,
				dpop: await dpopProof(device, jwk, {
					method: "POST",
					url: connectUrl,
				}),
				"content-type": "application/json",
			},
			body: JSON.stringify({ wireProtocolVersion: 1 }),
		});
		const incompatible = await api.fetch(incompatibleRequest);
		expect(incompatible.status).toBe(409);
		expect(await incompatible.json()).toEqual({
			error: "version_incompatible",
		});

		const managedRequest = new Request(connectUrl, {
			method: "POST",
			headers: {
				authorization: `DPoP ${accessToken}`,
				dpop: await dpopProof(device, jwk, {
					method: "POST",
					url: connectUrl,
				}),
				"content-type": "application/json",
			},
			body: JSON.stringify({
				wireProtocolVersion: 2,
				requireManaged: true,
			}),
		});
		const unavailable = await api.fetch(managedRequest);
		expect(unavailable.status).toBe(503);
		expect(await unavailable.json()).toEqual({
			error: "tunnel_unavailable",
		});
	});

	test("accepts a public HTTPS endpoint when managed connectivity is required", async () => {
		const environmentId = "env_public_endpoint";
		await linkEnvironment({
			account: "user_public_endpoint",
			environmentId,
			wireProtocolVersion: 2,
			endpoint: {
				httpBaseUrl: "https://47837-sandbox.sandbox.test",
				wsBaseUrl: "wss://47837-sandbox.sandbox.test",
			},
		});
		const device = (await ec()) as KeyPair;
		const jwk = await exportJWK(device.publicKey);
		const accessToken = await mintAccess("user_public_endpoint", device, jwk);
		const connectUrl = `${API_ISSUER}/v1/environments/${environmentId}/connect`;
		const response = await api.fetch(
			new Request(connectUrl, {
				method: "POST",
				headers: {
					authorization: `DPoP ${accessToken}`,
					dpop: await dpopProof(device, jwk, {
						method: "POST",
						url: connectUrl,
					}),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					wireProtocolVersion: 2,
					requireManaged: true,
				}),
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			endpoint: {
				httpBaseUrl: "https://47837-sandbox.sandbox.test",
				wsBaseUrl: "wss://47837-sandbox.sandbox.test",
			},
		});
	});

	test("rejects a request with no WorkOS bearer", async () => {
		const res = await api.fetch(
			new Request(`${API_ISSUER}/v1/environments`, { method: "GET" }),
		);
		expect(res.status).toBe(401);
	});

	test("deletes account-owned api data and remains idempotent", async () => {
		const { credential } = await linkEnvironment({
			account: "user_delete",
			environmentId: "env_delete",
		});
		const request = () =>
			api.fetch(
				new Request(`${API_ISSUER}/v1/account`, {
					method: "DELETE",
					headers: { authorization: "Bearer test-token:user_delete" },
				}),
			);

		expect((await request()).status).toBe(200);
		expect((await request()).status).toBe(200);
		expect(identityDeletes).toEqual(["user_delete", "user_delete"]);

		const list = await api.fetch(
			new Request(`${API_ISSUER}/v1/environments`, {
				headers: { authorization: "Bearer test-token:user_delete" },
			}),
		);
		expect((await list.json()).environments).toHaveLength(0);
		expect((await heartbeat("env_delete", credential)).status).toBe(401);
	});

	test("revokes account access immediately and defers identity deletion until machine cleanup", async () => {
		const apiKeyResponse = await api.fetch(
			new Request(`${API_ISSUER}/v1/cloud/api-keys`, {
				method: "POST",
				headers: {
					authorization: "Bearer test-token:user_a",
					"content-type": "application/json",
				},
				body: JSON.stringify({ name: "delete lifecycle" }),
			}),
		);
		expect(apiKeyResponse.status).toBe(201);
		const apiKey = (await apiKeyResponse.json()) as { readonly secret: string };
		const create = await api.fetch(
			new Request(`${API_ISSUER}/v1/machines`, {
				method: "POST",
				headers: {
					authorization: "Bearer test-token:user_a",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					offerId: "persistent-standard-v1",
					idempotencyKey: "delete-account-machine",
				}),
			}),
		);
		expect(create.status).toBe(201);
		await api.reconcile("provision-before-delete");

		const deletion = await api.fetch(
			new Request(`${API_ISSUER}/v1/account`, {
				method: "DELETE",
				headers: { authorization: "Bearer test-token:user_a" },
			}),
		);
		expect(deletion.status).toBe(202);
		expect(await deletion.json()).toEqual({
			ok: true,
			cleanupPending: true,
		});
		expect(identityDeletes).toEqual([]);
		expect(
			(
				await api.fetch(
					new Request(`${API_ISSUER}/v1/api/projects`, {
						headers: { authorization: `Bearer ${apiKey.secret}` },
					}),
				)
			).status,
		).toBe(401);

		await api.reconcile("account-cleanup");
		expect(identityDeletes).toEqual(["user_a"]);

		const machines = await api.fetch(
			new Request(`${API_ISSUER}/v1/machines`, {
				headers: { authorization: "Bearer test-token:user_a" },
			}),
		);
		expect(await machines.json()).toMatchObject({
			machines: [{ state: "destroyed", statusCode: "destroyed" }],
		});
	});

	test("scopes environments by account — cross-account access is denied", async () => {
		await linkEnvironment({ account: "user_a", environmentId: "env_a" });

		// user_b lists: sees nothing.
		const listB = await api.fetch(
			new Request(`${API_ISSUER}/v1/environments`, {
				method: "GET",
				headers: { authorization: "Bearer test-token:user_b" },
			}),
		);
		expect((await listB.json()).environments).toHaveLength(0);

		// user_b cannot connect to user_a's environment (404, not leaked).
		const device = (await ec()) as KeyPair;
		const jwk = await exportJWK(device.publicKey);
		const accessToken = await mintAccess("user_b", device, jwk);
		const connectUrl = `${API_ISSUER}/v1/environments/env_a/connect`;
		const res = await api.fetch(
			new Request(connectUrl, {
				method: "POST",
				headers: {
					authorization: `DPoP ${accessToken}`,
					dpop: await dpopProof(device, jwk, {
						method: "POST",
						url: connectUrl,
					}),
				},
			}),
		);
		expect(res.status).toBe(404);
	});

	test("rejects a forged link proof (wrong key)", async () => {
		const bearer = "Bearer test-token:user_a";
		const challengeRes = await api.fetch(
			new Request(`${API_ISSUER}/v1/client/environment-link-challenges`, {
				method: "POST",
				headers: { authorization: bearer },
			}),
		);
		const challenge = (await challengeRes.json()) as {
			challengeId: string;
			challenge: string;
		};

		const realKey = (await eddsa()) as KeyPair;
		const attackerKey = (await eddsa()) as KeyPair;
		// Proof signed by the attacker, but claims the victim's public key.
		const proof = await signLinkProof(attackerKey, {
			challenge: challenge.challenge,
			environmentId: "env_x",
		});
		const res = await api.fetch(
			new Request(`${API_ISSUER}/v1/client/environment-links`, {
				method: "POST",
				headers: { authorization: bearer, "content-type": "application/json" },
				body: JSON.stringify({
					challengeId: challenge.challengeId,
					proof,
					environmentId: "env_x",
					environmentPublicKey: JSON.stringify(
						await exportJWK(realKey.publicKey),
					),
					providerKind: "desktop",
					endpoint: {
						httpBaseUrl: "http://127.0.0.1:8787",
						wsBaseUrl: "ws://127.0.0.1:8787/rpc",
					},
				}),
			}),
		);
		expect(res.status).toBe(401);
	});

	test("rejects a replayed DPoP proof", async () => {
		await linkEnvironment({ account: "user_a", environmentId: "env_1" });
		const device = (await ec()) as KeyPair;
		const jwk = await exportJWK(device.publicKey);
		const accessToken = await mintAccess("user_a", device, jwk);

		const statusUrl = `${API_ISSUER}/v1/environments/env_1/status`;
		const proof = await dpopProof(device, jwk, {
			method: "POST",
			url: statusUrl,
		});
		const headers = { authorization: `DPoP ${accessToken}`, dpop: proof };

		const first = await api.fetch(
			new Request(statusUrl, { method: "POST", headers }),
		);
		expect(first.status).toBe(200);
		const replay = await api.fetch(
			new Request(statusUrl, { method: "POST", headers }),
		);
		expect(replay.status).toBe(401);
		expect((await replay.json()).error).toBe("dpop_replayed");
	});

	test("rejects chat bytes on the activity endpoint", async () => {
		const { credential } = await linkEnvironment({
			account: "user_a",
			environmentId: "env_1",
		});
		const res = await api.fetch(
			new Request(`${API_ISSUER}/v1/environments/env_1/agent-activity`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${credential}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					sessionId: "s1",
					kind: "completed",
					messages: ["chat"],
				}),
			}),
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("chat_data_not_allowed");
	});

	test("fans sanitized activity out to registered push devices", async () => {
		const { credential } = await linkEnvironment({
			account: "user_a",
			environmentId: "env_1",
		});
		const device = (await ec()) as KeyPair;
		const jwk = await exportJWK(device.publicKey);
		const accessToken = await mintAccess("user_a", device, jwk);
		const devicesUrl = `${API_ISSUER}/v1/mobile/devices`;
		const register = await api.fetch(
			new Request(devicesUrl, {
				method: "POST",
				headers: {
					authorization: `DPoP ${accessToken}`,
					dpop: await dpopProof(device, jwk, {
						method: "POST",
						url: devicesUrl,
					}),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					deviceId: "phone_1",
					platform: "ios",
					pushToken: "ExponentPushToken[test]",
				}),
			}),
		);
		expect(register.status).toBe(200);

		const activity = await api.fetch(
			new Request(`${API_ISSUER}/v1/environments/env_1/agent-activity`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${credential}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					sessionId: "s1",
					kind: "approval-needed",
					title: "Test Mac",
				}),
			}),
		);

		expect(activity.status).toBe(200);
		expect(await activity.json()).toEqual({ delivered: 1 });
		expect(pushCalls).toHaveLength(1);
		expect(pushCalls[0]).toEqual([
			{
				to: "ExponentPushToken[test]",
				environmentId: "env_1",
				kind: "approval-needed",
				target: "zuse:///",
			},
		]);
	});

	test("rejects message-shaped activity payload fields", async () => {
		const { credential } = await linkEnvironment({
			account: "user_a",
			environmentId: "env_1",
		});
		const sensitivePayloads = [
			{ message: "hello" },
			{ content: "hello" },
			{ text: "hello" },
			{ toolArgs: { command: "pwd" } },
			{ toolInput: { path: "/tmp/x" } },
			{ output: "stdout" },
			{ filePath: "/tmp/x" },
			{ nested: { path: "/tmp/x" } },
		];

		for (const payload of sensitivePayloads) {
			const res = await api.fetch(
				new Request(`${API_ISSUER}/v1/environments/env_1/agent-activity`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${credential}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						sessionId: "s1",
						kind: "completed",
						...payload,
					}),
				}),
			);
			expect(res.status).toBe(400);
			expect((await res.json()).error).toBe("chat_data_not_allowed");
		}
	});
});

// --- managed Cloudflare tunnel ------------------------------------------------

const FAKE_TUNNEL: Config.ManagedTunnelConfig = {
	cfApiToken: Redacted.make("cf-token"),
	cfAccountId: "acct_1",
	cfZoneId: "zone_1",
	baseDomain: "test",
	namespace: "zenv",
};

/**
 * Stub the Cloudflare v4 API. Returns the CF envelope shape the provider
 * expects and records every call so deprovision can be asserted.
 */
const stubCloudflare = () => {
	const calls: Array<{ method: string; path: string; body?: unknown }> = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (
		input: Request | string | URL,
		init?: RequestInit,
	) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = (init?.method ?? "GET").toUpperCase();
		const path = new URL(url).pathname + new URL(url).search;
		calls.push({
			method,
			path,
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		});
		const ok = (result: unknown) =>
			new Response(JSON.stringify({ success: true, result }), { status: 200 });
		if (path.includes("/cfd_tunnel/") && path.includes("/token")) {
			return ok("connector-token-xyz");
		}
		if (path.includes("/cfd_tunnel/") && path.includes("/configurations")) {
			return ok({});
		}
		if (path.includes("/cfd_tunnel") && method === "GET") return ok([]); // no existing
		if (path.includes("/cfd_tunnel") && method === "POST") {
			return ok({ id: "tunnel_abc", name: "zenv-xyz" });
		}
		if (path.includes("/cfd_tunnel/") && method === "DELETE") return ok({});
		if (path.includes("/dns_records") && method === "GET") return ok([]);
		if (path.includes("/dns_records") && method === "POST") {
			return ok({ id: "dns_1", name: "host" });
		}
		if (path.includes("/dns_records/") && method === "DELETE") return ok({});
		return ok({});
	}) as typeof fetch;
	return {
		calls,
		restore: () => {
			globalThis.fetch = realFetch;
		},
	};
};

const linkWithTunnel = async (account: string, environmentId: string) => {
	const bearer = `test-token:${account}`;
	const challengeRes = await api.fetch(
		new Request(`${API_ISSUER}/v1/client/environment-link-challenges`, {
			method: "POST",
			headers: { authorization: `Bearer ${bearer}` },
		}),
	);
	const challenge = (await challengeRes.json()) as {
		challengeId: string;
		challenge: string;
	};
	const envKey = (await eddsa()) as KeyPair;
	const proof = await signLinkProof(envKey, {
		challenge: challenge.challenge,
		environmentId,
	});
	const linkRes = await api.fetch(
		new Request(`${API_ISSUER}/v1/client/environment-links`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${bearer}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				challengeId: challenge.challengeId,
				proof,
				environmentId,
				environmentPublicKey: JSON.stringify(await exportJWK(envKey.publicKey)),
				providerKind: "desktop",
				endpoint: {
					httpBaseUrl: "http://127.0.0.1:8787",
					wsBaseUrl: "ws://127.0.0.1:8787/rpc",
				},
				managedTunnel: true,
				origin: { localHttpHost: "127.0.0.1", localHttpPort: 8787 },
			}),
		}),
	);
	return linkRes;
};

describe("@zuse/api managed tunnel", () => {
	test("provisions a tunnel on link and returns a connector token", async () => {
		const cf = stubCloudflare();
		try {
			api = makeApi(await makeLayer(FAKE_TUNNEL));
			const res = await linkWithTunnel("user_a", "env_t");
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				tunnelHostname?: string;
				connectorToken?: string;
				endpoint: { wsBaseUrl: string };
			};
			expect(body.connectorToken).toBe("connector-token-xyz");
			expect(body.tunnelHostname).toBe(
				`zenv-${body.tunnelHostname?.split("-")[1]}`,
			);
			expect(body.endpoint.wsBaseUrl).toBe(`wss://${body.tunnelHostname}`);

			// The discovery list now advertises the managed endpoint.
			const list = await api.fetch(
				new Request(`${API_ISSUER}/v1/environments`, {
					method: "GET",
					headers: { authorization: "Bearer test-token:user_a" },
				}),
			);
			const listed = (await list.json()).environments[0];
			expect(listed.endpoint.wsBaseUrl).toBe(`wss://${body.tunnelHostname}`);
		} finally {
			cf.restore();
		}
	});

	test("unlink deprovisions the tunnel and removes the environment", async () => {
		const cf = stubCloudflare();
		try {
			api = makeApi(await makeLayer(FAKE_TUNNEL));
			await linkWithTunnel("user_a", "env_t");
			const res = await api.fetch(
				new Request(`${API_ISSUER}/v1/client/environment-unlink`, {
					method: "POST",
					headers: {
						authorization: "Bearer test-token:user_a",
						"content-type": "application/json",
					},
					body: JSON.stringify({ environmentId: "env_t" }),
				}),
			);
			expect(res.status).toBe(200);
			// Tunnel + DNS deletes were issued.
			expect(
				cf.calls.some(
					(c) => c.method === "DELETE" && c.path.includes("/cfd_tunnel/"),
				),
			).toBe(true);
			expect(
				cf.calls.some(
					(c) => c.method === "DELETE" && c.path.includes("/dns_records/"),
				),
			).toBe(true);
			// Environment is gone.
			const list = await api.fetch(
				new Request(`${API_ISSUER}/v1/environments`, {
					method: "GET",
					headers: { authorization: "Bearer test-token:user_a" },
				}),
			);
			expect((await list.json()).environments).toHaveLength(0);
		} finally {
			cf.restore();
		}
	});

	test("an authenticated heartbeat reconciles a changed desktop origin", async () => {
		const cf = stubCloudflare();
		try {
			api = makeApi(await makeLayer(FAKE_TUNNEL));
			const linked = await linkWithTunnel("user_a", "env_t");
			const { environmentCredential } = (await linked.json()) as {
				environmentCredential: string;
			};
			const res = await api.fetch(
				new Request(`${API_ISSUER}/v1/environments/env_t/heartbeat`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${environmentCredential}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						origin: { localHttpHost: "127.0.0.1", localHttpPort: 8788 },
					}),
				}),
			);
			expect(res.status).toBe(200);
			expect(
				cf.calls.some(
					(call) =>
						call.method === "PUT" &&
						call.path.includes("/configurations") &&
						JSON.stringify(call.body).includes("http://127.0.0.1:8788"),
				),
			).toBe(true);
		} finally {
			cf.restore();
		}
	});

	test("origin reconciliation rejects non-loopback targets", async () => {
		const cf = stubCloudflare();
		try {
			api = makeApi(await makeLayer(FAKE_TUNNEL));
			const linked = await linkWithTunnel("user_a", "env_t");
			const { environmentCredential } = (await linked.json()) as {
				environmentCredential: string;
			};
			const callsBefore = cf.calls.length;
			const res = await api.fetch(
				new Request(`${API_ISSUER}/v1/environments/env_t/heartbeat`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${environmentCredential}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						origin: { localHttpHost: "10.0.0.8", localHttpPort: 8788 },
					}),
				}),
			);
			expect(res.status).toBe(400);
			expect((await res.json()).error).toBe("invalid_tunnel_origin");
			expect(cf.calls).toHaveLength(callsBefore);
		} finally {
			cf.restore();
		}
	});

	test("link succeeds without a tunnel when provisioning is disabled", async () => {
		api = makeApi(await makeLayer()); // no managedTunnel config
		const res = await linkWithTunnel("user_a", "env_t");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			connectorToken?: string;
			endpoint: { wsBaseUrl: string };
		};
		expect(body.connectorToken).toBeUndefined();
		expect(body.endpoint.wsBaseUrl).toBe("ws://127.0.0.1:8787/rpc"); // LAN fallback
	});

	test("connects cloud projects idempotently and queues provider-scoped builds", async () => {
		const provider = placementAdapter("fake");
		api = makeApi(
			await makeLayer(
				undefined,
				BillingProvidersManual,
				false,
				{},
				SandboxProviders.layer({
					registrations: [{ adapter: provider }],
					defaultProviderId: provider.providerId,
				}).pipe(Layer.orDie),
			),
		);
		const connect = () =>
			api.fetch(
				new Request(`${API_ISSUER}${ApiPaths.cloudProjects}`, {
					method: "POST",
					headers: {
						authorization: "Bearer test-token:user_a",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						repositoryUrl: "https://github.com/acme/app",
						defaultBranch: "main",
						visibility: "public",
						idempotencyKey: "connect-app",
					}),
				}),
			);
		const first = await connect();
		expect(first.status).toBe(201);
		const project = (await first.json()) as { projectId: string };
		const duplicate = await connect();
		expect((await duplicate.json()) as { projectId: string }).toMatchObject({
			projectId: project.projectId,
		});

		const prepare = await api.fetch(
			new Request(
				`${API_ISSUER}${ApiPaths.cloudProjectPrepare(project.projectId)}`,
				{
					method: "POST",
					headers: {
						authorization: "Bearer test-token:user_a",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						projectId: project.projectId,
						providerId: "fake",
						idempotencyKey: "prepare-app",
					}),
				},
			),
		);
		expect(prepare.status).toBe(202);
		expect(prepare.headers.get("x-zuse-reconcile-cloud-build")).toBeTruthy();
		expect(await prepare.json()).toMatchObject({
			projectId: project.projectId,
			providerId: "fake",
			state: "queued",
		});
	});

	test("rejects repository URLs containing credentials", async () => {
		api = makeApi(await makeLayer());
		const response = await api.fetch(
			new Request(`${API_ISSUER}${ApiPaths.cloudProjects}`, {
				method: "POST",
				headers: {
					authorization: "Bearer test-token:user_a",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					repositoryUrl: "https://token@github.com/acme/app.git",
					defaultBranch: "main",
					visibility: "private",
					idempotencyKey: "unsafe",
				}),
			}),
		);
		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("invalid_repository");
	});
});

describe("preview URL revocation authorization", () => {
	test("permits revocation while paused, rejects another account and the runtime port", async () => {
		const calls: Array<{ sandboxId: string; port?: number }> = [];
		const providers = SandboxProviders.layer({
			defaultProviderId: "fake",
			registrations: [
				{
					adapter: {
						...placementAdapter("fake"),
						revokeEndpoint: (sandboxId, port) =>
							Effect.sync(() => {
								calls.push({ sandboxId, port });
							}),
					},
				},
			],
		}).pipe(Layer.orDie);
		const runtime = ManagedRuntime.make(
			await makeLayer(undefined, undefined, false, {}, providers),
		);
		try {
			const store = await runtime.runPromise(CloudWorkspaceStore);
			await runtime.runPromise(
				store.createWorkspace(
					{
						workspaceId: "preview-workspace",
						accountId: "user_a",
						projectId: "project",
						buildId: "build",
						provider: "fake",
						providerSandboxId: "sandbox",
						runtimeState: "offline",
						chatId: "chat",
						initialSessionId: "session",
						branch: "preview-test",
						baseRef: "main",
						state: "paused",
						desiredState: "paused",
						statusCode: "paused",
						idempotencyKey: "preview-test",
						requestConfig: {},
						nextActionAtMs: 100,
						revision: 1,
						createdAtMs: 100,
						updatedAtMs: 100,
						lastActivityAtMs: 100,
					},
					{
						workspaceId: "preview-workspace",
						accountId: "user_a",
						chatId: "chat",
						sessionId: "session",
						turnId: "turn",
						commandId: "command",
						ciphertext: "sealed",
						expiresAtMs: Date.now() + 10000,
						createdAtMs: 100,
					},
				),
			);
			const request = (account: string, port?: number) =>
				routeCloudWorkspaceRequest(
					new Request(
						`${API_ISSUER}/v1/cloud/workspaces/preview-workspace/preview-url`,
						{
							method: "DELETE",
							headers: {
								authorization: `Bearer test-token:${account}`,
								"content-type": "application/json",
							},
							body: JSON.stringify({ port }),
						},
					),
				);
			await expect(
				runtime.runPromise(request("user_b", 3001)),
			).rejects.toMatchObject({ code: "cloud_workspace_not_found" });
			await expect(
				runtime.runPromise(request("user_a", 47837)),
			).rejects.toMatchObject({ code: "invalid_preview_port" });
			expect(calls).toEqual([]);
			const response = await runtime.runPromise(request("user_a", 3001));
			expect(await response?.json()).toEqual({
				workspaceId: "preview-workspace",
				port: 3001,
			});
			await runtime.runPromise(request("user_a"));
			expect(calls).toEqual([
				{ sandboxId: "sandbox", port: 3001 },
				{ sandboxId: "sandbox", port: undefined },
			]);
		} finally {
			await runtime.dispose();
		}
	});
});
