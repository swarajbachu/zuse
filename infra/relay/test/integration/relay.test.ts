import {
	type BillingProviderAdapter,
	BillingProviderError,
	BillingProviders,
	BillingProvidersManual,
} from "@zuse/billing-providers";
import { RelayPaths } from "@zuse/contracts";
import { MachineProvidersFake } from "@zuse/machine-providers/testing";
import {
	type SandboxProviderAdapter,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { SandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { Effect, Layer, Redacted } from "effect";
import {
	exportJWK,
	generateKeyPair,
	importJWK,
	type JWK,
	jwtVerify,
	SignJWT,
} from "jose";
import { beforeEach, describe, expect, test } from "vitest";
import * as Config from "../../src/config.ts";
import type { RelayContext } from "../../src/handler.ts";
import {
	AccountIdentity,
	BetaAccess,
	BetaAccessAllowAll,
	BetaAccessDenied,
	CloudBillingStoreMemory,
	CloudCredentialVault,
	CloudCredentialVaultLive,
	CloudWorkspaceLaunchIntentCipher,
	CloudWorkspaceLaunchIntentCipherLive,
	CloudWorkspaceStoreMemory,
	type MachineControlConfig,
	MachineControlConfiguration,
	MachineStoreMemory,
	ManagedTunnelProviderLive,
	makeRelay,
	PushDelivery,
	RelayStoreMemory,
} from "../../src/index.ts";
import { SandboxOfferConfiguration } from "../../src/sandbox-provider-module.ts";
import { WorkosVerifierTest } from "../../src/workos.ts";

const RELAY_ISSUER = "https://relay.test";

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
		.setAudience(RELAY_ISSUER)
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

let relay: ReturnType<typeof makeRelay>;
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
	betaAccessLayer: Layer.Layer<BetaAccess> = BetaAccessAllowAll,
): Promise<Layer.Layer<RelayContext>> => {
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
		relayIssuer: RELAY_ISSUER,
		workosJwksUrl: "https://unused.test/jwks",
		workosIssuer: "https://unused.test",
		mintPrivateKey: Redacted.make(
			JSON.stringify(await exportJWK(mintKey.privateKey)),
		),
		mintPublicKey: JSON.stringify(await exportJWK(mintKey.publicKey)),
		cloudCredentialVaultKey: Redacted.make(
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
		betaAccessLayer,
		WorkosVerifierTest,
		RelayStoreMemory,
		MachineStoreMemory,
		CloudWorkspaceStoreMemory,
		CloudBillingStoreMemory,
		Layer.effect(CloudCredentialVault, CloudCredentialVaultLive).pipe(
			Layer.provide(configLayer),
			Layer.orDie,
		),
		Layer.effect(
			CloudWorkspaceLaunchIntentCipher,
			CloudWorkspaceLaunchIntentCipherLive,
		).pipe(Layer.provide(configLayer), Layer.orDie),
		MachineProvidersFake,
		sandboxProvidersLayer,
		Layer.succeed(SandboxOfferConfiguration, {
			port: 47_837,
			vcpuCount: 2,
			memoryMib: 1_024,
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
	const challengeRes = await relay.fetch(
		new Request(`${RELAY_ISSUER}/v1/client/environment-link-challenges`, {
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
	const linkRes = await relay.fetch(
		new Request(`${RELAY_ISSUER}/v1/client/environment-links`, {
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
	relay.fetch(
		new Request(`${RELAY_ISSUER}/v1/environments/${environmentId}/heartbeat`, {
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
	const url = `${RELAY_ISSUER}/v1/client/dpop-token`;
	const res = await relay.fetch(
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
	relay = makeRelay(await makeLayer());
});

describe("@zuse/relay", () => {
	test("gates hosted operations without blocking local links or resource cleanup", async () => {
		const gatedRelay = makeRelay(
			await makeLayer(
				undefined,
				BillingProvidersManual,
				false,
				{},
				SandboxProvidersFake,
				Layer.succeed(
					BetaAccess,
					BetaAccess.of({
						check: () => Effect.fail(new BetaAccessDenied()),
						grant: () => Effect.void,
					}),
				),
			),
		);
		const headers = { authorization: "Bearer test-token:user_a" };
		const hosted = await gatedRelay.fetch(
			new Request(`${RELAY_ISSUER}/v1/machine-offers`, { headers }),
		);
		expect(hosted.status).toBe(403);
		expect(await hosted.json()).toEqual({
			error: "cloud_beta_access_required",
		});
		const resume = await gatedRelay.fetch(
			new Request(`${RELAY_ISSUER}/v1/cloud/workspaces/missing/resume`, {
				method: "POST",
				headers,
			}),
		);
		expect(resume.status).toBe(403);

		const portal = await gatedRelay.fetch(
			new Request(`${RELAY_ISSUER}${RelayPaths.billingPortal}`, {
				method: "POST",
				headers,
			}),
		);
		expect(portal.status).toBe(503);
		expect(await portal.json()).toEqual({
			error: "billing_provider_unavailable",
		});

		for (const action of ["pause", "archive", "delete"] as const) {
			const cleanup = await gatedRelay.fetch(
				new Request(`${RELAY_ISSUER}/v1/cloud/workspaces/missing/${action}`, {
					method: "POST",
					headers,
				}),
			);
			expect(cleanup.status).toBe(404);
			expect(await cleanup.json()).toEqual({
				error: "cloud_workspace_not_found",
			});
		}

		const cancel = await gatedRelay.fetch(
			new Request(`${RELAY_ISSUER}/v1/machines/missing/cancel`, {
				method: "POST",
				headers,
			}),
		);
		expect(cancel.status).toBe(404);
		const destroy = await gatedRelay.fetch(
			new Request(`${RELAY_ISSUER}/v1/machines/missing/destroy`, {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify({ machineId: "missing", confirmation: "destroy" }),
			}),
		);
		expect(destroy.status).toBe(404);

		const local = await gatedRelay.fetch(
			new Request(`${RELAY_ISSUER}/v1/client/environment-link-challenges`, {
				method: "POST",
				headers,
			}),
		);
		expect(local.status).toBe(200);
		await gatedRelay.dispose();
	});

	test("offers each server-owned cloud machine and makes creation idempotent", async () => {
		const headers = {
			authorization: "Bearer test-token:user_a",
			"content-type": "application/json",
		};
		const offers = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/machine-offers`, { headers }),
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
			relay.fetch(
				new Request(`${RELAY_ISSUER}/v1/machines`, {
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

		const list = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/machines`, { headers }),
		);
		const listBody = await list.json();
		expect(JSON.stringify(listBody)).not.toContain("providerServerId");
		expect(JSON.stringify(listBody)).not.toContain("lastError");

		const another = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/machines`, {
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
		const response = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/billing/checkout`, {
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

	test("creates checkout with the relay-owned HTTPS completion page", async () => {
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
		const billingRelay = makeRelay(
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
			const response = await billingRelay.fetch(
				new Request(`${RELAY_ISSUER}${RelayPaths.billingCheckout}`, {
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
				`${RELAY_ISSUER}${RelayPaths.billingCheckoutComplete}`,
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
					`${RELAY_ISSUER}${RelayPaths.billingCheckoutComplete}`,
				);
				for (const [key, value] of Object.entries(params)) {
					target.searchParams.set(key, value);
				}
				return target.toString();
			};

			const completion = await billingRelay.fetch(
				new Request(
					completeUrl({
						checkout_id: "checkout_abcdef123456",
						t: receiptTicket,
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
			expect(completionPage).toContain("$19.00");
			expect(completionPage).toContain("Paid");

			// Without the relay-signed ticket nothing is looked up at all, so a
			// stolen checkout id discloses nothing.
			const unticketed = await billingRelay.fetch(
				new Request(completeUrl({ checkout_id: "checkout_abcdef123456" })),
			);
			const unticketedPage = await unticketed.text();
			expect(unticketed.status).toBe(200);
			expect(checkoutLookups).toHaveLength(1);
			expect(unticketedPage).toContain("Awaiting confirmation");
			expect(unticketedPage).not.toContain("ZS-EF123456");

			// A forged or expired ticket is treated the same as none.
			const forged = await billingRelay.fetch(
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
			const placeholderCompletion = await billingRelay.fetch(
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
			await billingRelay.dispose();
		}
	});

	test("claims a checkout-link subscription by verified WorkOS email", async () => {
		verifiedIdentityEmail = "buyer@example.com";
		const grantedAccounts: string[] = [];
		const billing: BillingProviderAdapter = {
			providerId: "billing-test",
			checkout: () => Effect.die("unused"),
			getCheckout: () => Effect.succeed(null),
			verifyEvent: () => Effect.die("unused"),
			claimSubscriptions: ({ accountId, verifiedEmail }) => {
				expect({ accountId, verifiedEmail }).toEqual({
					accountId: "user_a",
					verifiedEmail: "buyer@example.com",
				});
				return Effect.succeed(["subscription_link"]);
			},
			reconcileSubscription: () =>
				Effect.succeed({
					accountId: "user_a",
					providerSubscriptionId: "subscription_link",
					status: "active",
					offerId: "cloud-workspace-standard-v1",
					periodStart: Date.parse("2026-08-01T00:00:00.000Z"),
					paidThrough: Date.parse("2026-09-01T00:00:00.000Z"),
				}),
			cancel: () => Effect.void,
			customerPortal: () => Effect.die("unused"),
		};
		const billingRelay = makeRelay(
			await makeLayer(
				undefined,
				BillingProviders.layer({
					adapters: [billing],
					defaultProviderId: billing.providerId,
				}).pipe(Layer.orDie),
				false,
				{},
				SandboxProvidersFake,
				Layer.succeed(
					BetaAccess,
					BetaAccess.of({
						check: () => Effect.fail(new BetaAccessDenied()),
						grant: (accountId) =>
							Effect.sync(() => {
								grantedAccounts.push(accountId);
							}),
					}),
				),
			),
		);

		try {
			const response = await billingRelay.fetch(
				new Request(`${RELAY_ISSUER}${RelayPaths.billingEntitlements}`, {
					headers: { authorization: "Bearer test-token:user_a" },
				}),
			);

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				entitlements: [
					{
						kind: "cloud-workspace",
						offerId: "cloud-workspace-standard-v1",
						status: "active",
					},
				],
			});
			expect(grantedAccounts).toEqual(["user_a"]);
		} finally {
			await billingRelay.dispose();
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
		const billingRelay = makeRelay(
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
			await billingRelay.fetch(
				new Request(`${RELAY_ISSUER}${RelayPaths.billingCheckout}`, {
					method: "POST",
					headers: {
						authorization: "Bearer test-token:user_a",
						"content-type": "application/json",
					},
					body: JSON.stringify({ offerId: "persistent-standard-v1" }),
				}),
			);
			const ticket = new URL(successUrl).searchParams.get("t") ?? "";
			const completion = await billingRelay.fetch(
				new Request(
					`${RELAY_ISSUER}${RelayPaths.billingCheckoutComplete}?checkout_id=checkout_abcdef123456&t=${encodeURIComponent(ticket)}`,
				),
			);
			const page = await completion.text();
			expect(completion.status).toBe(200);
			expect(page).toContain("Persistent Standard");
			expect(page).toContain("Awaiting confirmation");

			// Unknown offers are never echoed back into the page.
			const hostile = await billingRelay.fetch(
				new Request(
					`${RELAY_ISSUER}${RelayPaths.billingCheckoutComplete}?offer=${encodeURIComponent("<script>alert(1)</script>")}`,
				),
			);
			const hostilePage = await hostile.text();
			expect(hostile.status).toBe(200);
			expect(hostilePage).not.toContain("<script>alert");
			expect(hostilePage).toContain("Zuse subscription");
		} finally {
			await billingRelay.dispose();
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
		const billingRelay = makeRelay(
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
			const response = await billingRelay.fetch(
				new Request(`${RELAY_ISSUER}${RelayPaths.billingCheckout}`, {
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
			await billingRelay.dispose();
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
		const billingRelay = makeRelay(
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
			const activated = await billingRelay.fetch(
				new Request(
					`${RELAY_ISSUER}/v1/billing/webhook/${billing.providerId}`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							eventId: "replacement-active",
							subscriptionId: "replacement-subscription",
						}),
					},
				),
			);
			expect(activated.status).toBe(200);

			const listed = await billingRelay.fetch(
				new Request(`${RELAY_ISSUER}${RelayPaths.machines}`, {
					headers: { authorization: "Bearer test-token:user_a" },
				}),
			);
			const machine = (await listed.json()) as {
				readonly machines: ReadonlyArray<{ readonly machineId: string }>;
			};
			const machineId = machine.machines[0]?.machineId;
			expect(machineId).toBeDefined();

			const destroyed = await billingRelay.fetch(
				new Request(
					`${RELAY_ISSUER}${RelayPaths.machineDestroy(machineId ?? "")}`,
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
			await billingRelay.reconcile("replacement-destroy");

			status = "ended";
			const checkout = await billingRelay.fetch(
				new Request(`${RELAY_ISSUER}${RelayPaths.billingCheckout}`, {
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
			await billingRelay.dispose();
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
		const billingRelay = makeRelay(
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
			billingRelay.fetch(
				new Request(
					`${RELAY_ISSUER}/v1/billing/webhook/${billing.providerId}`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							eventId,
							subscriptionId: "subscription_1",
						}),
					},
				),
			);

		try {
			const first = await deliver("event_newer");
			const firstBody = (await first.json()) as {
				readonly machineId: string;
				readonly ok: boolean;
				readonly duplicate: boolean;
				readonly provisioningQueued: boolean;
			};
			const immediate = await billingRelay.reconcileMachine(
				firstBody.machineId,
				"webhook-test",
			);
			const unqualified = await billingRelay.fetch(
				new Request(`${RELAY_ISSUER}/v1/billing/webhook`, {
					method: "POST",
				}),
			);
			const portal = await billingRelay.fetch(
				new Request(`${RELAY_ISSUER}/v1/billing/portal`, {
					method: "POST",
					headers: { authorization: "Bearer test-token:user_a" },
				}),
			);
			const duplicateCreate = await billingRelay.fetch(
				new Request(`${RELAY_ISSUER}/v1/machines`, {
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
			const entitlements = await billingRelay.fetch(
				new Request(`${RELAY_ISSUER}/v1/billing/entitlements`, {
					headers: { authorization: "Bearer test-token:user_a" },
				}),
			);
			const machines = await billingRelay.fetch(
				new Request(`${RELAY_ISSUER}/v1/machines`, {
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
			await billingRelay.dispose();
		}
	});

	test("brokers browser PKCE token exchanges without exposing a general proxy", async () => {
		const response = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/auth/token`, {
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

		const refreshResponse = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/auth/token`, {
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

	test("verifies DPoP against the public relay URL behind a rewritten worker URL", async () => {
		const device = (await ec()) as KeyPair;
		const jwk = await exportJWK(device.publicKey);
		const publicUrl = `${RELAY_ISSUER}/v1/client/dpop-token`;
		const response = await relay.fetch(
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

	test("allows the hosted product origin without opening relay CORS broadly", async () => {
		const allowed = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/environments`, {
				method: "OPTIONS",
				headers: { origin: "https://code.zuse.sh" },
			}),
		);
		expect(allowed.status).toBe(204);
		expect(allowed.headers.get("access-control-allow-origin")).toBe(
			"https://code.zuse.sh",
		);

		const denied = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/environments`, {
				method: "OPTIONS",
				headers: { origin: "https://untrusted.test" },
			}),
		);
		expect(denied.headers.get("access-control-allow-origin")).toBeNull();

		const legacy = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/environments`, {
				method: "OPTIONS",
				headers: { origin: "https://app.zuse.sh" },
			}),
		);
		expect(legacy.headers.get("access-control-allow-origin")).toBeNull();
	});

	test("enforces the account computer limit without blocking an existing computer", async () => {
		relay = makeRelay(await makeLayer(undefined, 1));
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
		const response = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/environments`, {
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
		const devicesUrl = `${RELAY_ISSUER}/v1/mobile/devices`;
		const registered = await relay.fetch(
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

		const listed = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/clients`, {
				headers: { authorization: "Bearer test-token:user_clients" },
			}),
		);
		expect(await listed.json()).toMatchObject({
			clients: [{ clientId: "browser_one", platform: "web" }],
		});

		const revoked = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/clients/browser_one`, {
				method: "DELETE",
				headers: { authorization: "Bearer test-token:user_clients" },
			}),
		);
		expect(revoked.status).toBe(200);

		const statusUrl = `${RELAY_ISSUER}/v1/environments/env_clients/status`;
		const afterRevocation = await relay.fetch(
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
		const statusUrl = `${RELAY_ISSUER}/v1/environments/${environmentId}/status`;
		const offline = await relay.fetch(
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
		const online = await relay.fetch(
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
		const connectUrl = `${RELAY_ISSUER}/v1/environments/${environmentId}/connect`;
		const connect = await relay.fetch(
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
			{ issuer: RELAY_ISSUER, audience: `zuse-env:${environmentId}` },
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
		const connectUrl = `${RELAY_ISSUER}/v1/environments/${environmentId}/connect`;

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
		const incompatible = await relay.fetch(incompatibleRequest);
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
		const unavailable = await relay.fetch(managedRequest);
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
		const connectUrl = `${RELAY_ISSUER}/v1/environments/${environmentId}/connect`;
		const response = await relay.fetch(
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
		const res = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/environments`, { method: "GET" }),
		);
		expect(res.status).toBe(401);
	});

	test("deletes account-owned relay data and remains idempotent", async () => {
		const { credential } = await linkEnvironment({
			account: "user_delete",
			environmentId: "env_delete",
		});
		const request = () =>
			relay.fetch(
				new Request(`${RELAY_ISSUER}/v1/account`, {
					method: "DELETE",
					headers: { authorization: "Bearer test-token:user_delete" },
				}),
			);

		expect((await request()).status).toBe(200);
		expect((await request()).status).toBe(200);
		expect(identityDeletes).toEqual(["user_delete", "user_delete"]);

		const list = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/environments`, {
				headers: { authorization: "Bearer test-token:user_delete" },
			}),
		);
		expect((await list.json()).environments).toHaveLength(0);
		expect((await heartbeat("env_delete", credential)).status).toBe(401);
	});

	test("revokes account access immediately and defers identity deletion until machine cleanup", async () => {
		const create = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/machines`, {
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
		await relay.reconcile("provision-before-delete");

		const deletion = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/account`, {
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

		await relay.reconcile("account-cleanup");
		expect(identityDeletes).toEqual(["user_a"]);

		const machines = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/machines`, {
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
		const listB = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/environments`, {
				method: "GET",
				headers: { authorization: "Bearer test-token:user_b" },
			}),
		);
		expect((await listB.json()).environments).toHaveLength(0);

		// user_b cannot connect to user_a's environment (404, not leaked).
		const device = (await ec()) as KeyPair;
		const jwk = await exportJWK(device.publicKey);
		const accessToken = await mintAccess("user_b", device, jwk);
		const connectUrl = `${RELAY_ISSUER}/v1/environments/env_a/connect`;
		const res = await relay.fetch(
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
		const challengeRes = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/client/environment-link-challenges`, {
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
		const res = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/client/environment-links`, {
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

		const statusUrl = `${RELAY_ISSUER}/v1/environments/env_1/status`;
		const proof = await dpopProof(device, jwk, {
			method: "POST",
			url: statusUrl,
		});
		const headers = { authorization: `DPoP ${accessToken}`, dpop: proof };

		const first = await relay.fetch(
			new Request(statusUrl, { method: "POST", headers }),
		);
		expect(first.status).toBe(200);
		const replay = await relay.fetch(
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
		const res = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/environments/env_1/agent-activity`, {
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
		const devicesUrl = `${RELAY_ISSUER}/v1/mobile/devices`;
		const register = await relay.fetch(
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

		const activity = await relay.fetch(
			new Request(`${RELAY_ISSUER}/v1/environments/env_1/agent-activity`, {
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
				title: "Test Mac",
				target: "zuse://computers?environmentId=env_1",
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
			const res = await relay.fetch(
				new Request(`${RELAY_ISSUER}/v1/environments/env_1/agent-activity`, {
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
	const challengeRes = await relay.fetch(
		new Request(`${RELAY_ISSUER}/v1/client/environment-link-challenges`, {
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
	const linkRes = await relay.fetch(
		new Request(`${RELAY_ISSUER}/v1/client/environment-links`, {
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

describe("@zuse/relay managed tunnel", () => {
	test("provisions a tunnel on link and returns a connector token", async () => {
		const cf = stubCloudflare();
		try {
			relay = makeRelay(await makeLayer(FAKE_TUNNEL));
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
			const list = await relay.fetch(
				new Request(`${RELAY_ISSUER}/v1/environments`, {
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
			relay = makeRelay(await makeLayer(FAKE_TUNNEL));
			await linkWithTunnel("user_a", "env_t");
			const res = await relay.fetch(
				new Request(`${RELAY_ISSUER}/v1/client/environment-unlink`, {
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
			const list = await relay.fetch(
				new Request(`${RELAY_ISSUER}/v1/environments`, {
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
			relay = makeRelay(await makeLayer(FAKE_TUNNEL));
			const linked = await linkWithTunnel("user_a", "env_t");
			const { environmentCredential } = (await linked.json()) as {
				environmentCredential: string;
			};
			const res = await relay.fetch(
				new Request(`${RELAY_ISSUER}/v1/environments/env_t/heartbeat`, {
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
			relay = makeRelay(await makeLayer(FAKE_TUNNEL));
			const linked = await linkWithTunnel("user_a", "env_t");
			const { environmentCredential } = (await linked.json()) as {
				environmentCredential: string;
			};
			const callsBefore = cf.calls.length;
			const res = await relay.fetch(
				new Request(`${RELAY_ISSUER}/v1/environments/env_t/heartbeat`, {
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
		relay = makeRelay(await makeLayer()); // no managedTunnel config
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
		relay = makeRelay(
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
			relay.fetch(
				new Request(`${RELAY_ISSUER}${RelayPaths.cloudProjects}`, {
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

		const prepare = await relay.fetch(
			new Request(
				`${RELAY_ISSUER}${RelayPaths.cloudProjectPrepare(project.projectId)}`,
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
		relay = makeRelay(await makeLayer());
		const response = await relay.fetch(
			new Request(`${RELAY_ISSUER}${RelayPaths.cloudProjects}`, {
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
