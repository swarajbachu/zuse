import { BillingProviders } from "@zuse/billing-providers";
import {
	BillingCheckoutRequest,
	MachineBootStatusRequest,
	MachineCreateRequest,
	MachineDestroyRequest,
	MachineEnrollRequest,
	type MachineRecord,
	RelayPaths,
} from "@zuse/contracts";
import { MachineProviders } from "@zuse/machine-providers";
import { Clock, Effect, Schema } from "effect";

import { requireWorkos } from "./auth.ts";
import { cancelProviderSubscription } from "./billing-operations.ts";
import { RelayConfiguration } from "./config.ts";
import {
	parseJwk,
	randomToken,
	sha256Hex,
	verifyEnvironmentLinkProof,
} from "./crypto.ts";
import {
	badRequest,
	conflict,
	forbidden,
	gone,
	notFound,
	type RelayError,
	serviceUnavailable,
	unauthorized,
} from "./errors.ts";
import { MachineControlConfiguration } from "./machine-config.ts";
import { requestMachineDestruction } from "./machine-lifecycle.ts";
import { findMachineOffer, MACHINE_OFFERS } from "./machine-offers.ts";
import { machineProviderLabel } from "./machine-provider-label.ts";
import {
	type EntitlementPersistenceRecord,
	type MachinePersistenceRecord,
	MachineStore,
} from "./machine-store.ts";
import { ManagedTunnelProvider } from "./managed-tunnel.ts";
import { RelayStore } from "./store.ts";
import type { WorkosVerifier } from "./workos.ts";

export type MachineRouteContext =
	| WorkosVerifier
	| MachineStore
	| MachineProviders
	| BillingProviders
	| RelayConfiguration
	| RelayStore
	| ManagedTunnelProvider;

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const checkoutComplete = (): Response =>
	new Response(
		`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Checkout submitted - Zuse</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0d0d;color:#f2f2f2;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:min(30rem,calc(100% - 2rem));padding:2rem;border:1px solid #303030;border-radius:1rem;background:#191919}h1{margin:0;font-size:1.5rem;line-height:1.25}p{margin:1rem 0 0;color:#aaa;line-height:1.5}.status{color:#caff00}
</style>
</head>
<body><main class="card"><h1><span class="status">Checkout submitted.</span> Return to Zuse.</h1><p>We are waiting for payment confirmation. Your cloud machine will appear automatically when provisioning begins. You can close this tab.</p></main></body>
</html>`,
		{
			status: 200,
			headers: {
				"cache-control": "no-store",
				"content-security-policy":
					"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
				"content-type": "text/html; charset=utf-8",
				"x-content-type-options": "nosniff",
			},
		},
	);

const matchBillingWebhookPath = (
	path: string,
): { readonly providerId?: string } | null => {
	if (path === RelayPaths.billingWebhook) return {};
	const prefix = `${RelayPaths.billingWebhook}/`;
	if (!path.startsWith(prefix)) return null;
	const providerId = path.slice(prefix.length);
	return providerId.length > 0 && !providerId.includes("/")
		? { providerId }
		: null;
};

const decodeBody = <A, I>(
	schema: Schema.Codec<A, I>,
	request: Request,
): Effect.Effect<A, RelayError> =>
	Effect.tryPromise({
		try: (): Promise<unknown> => request.json(),
		catch: () => badRequest("invalid_json"),
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(schema)),
		Effect.mapError(() => badRequest("invalid_request")),
	);

const toPublicMachine = (machine: MachinePersistenceRecord): MachineRecord => {
	const offer = findMachineOffer(machine.offerId);
	if (offer === undefined) {
		throw new Error(`Unknown persisted machine offer: ${machine.offerId}`);
	}
	return {
		machineId: machine.machineId,
		offer,
		label: machine.label,
		state: machine.state,
		desiredState: machine.desiredState,
		statusCode: machine.statusCode,
		bootPhase: machine.bootPhase,
		environmentId: machine.environmentId as MachineRecord["environmentId"],
		createdAt: machine.createdAtMs,
		paidThrough: machine.paidThroughMs,
		recoveryDeadline: machine.recoveryDeadlineMs,
	};
};

const toPublicEntitlement = (entitlement: EntitlementPersistenceRecord) => ({
	entitlementId: entitlement.entitlementId,
	kind: entitlement.kind,
	status: entitlement.status,
	offerId: entitlement.offerId,
	paidThrough: entitlement.paidThroughMs,
	creditBalance: entitlement.creditBalance,
});

const requireAlphaAccess = (
	accountId: string,
): Effect.Effect<void, RelayError> =>
	Effect.gen(function* () {
		const config = yield* MachineControlConfiguration;
		if (!config.allowlistedAccountIds.has(accountId)) {
			return yield* Effect.fail(forbidden("machine_alpha_not_allowed"));
		}
	});

const requireMachineAlphaPrincipal = Effect.fn("requireMachineAlphaPrincipal")(
	function* (request: Request) {
		const principal = yield* requireWorkos(request);
		yield* requireAlphaAccess(principal.accountId);
		return principal;
	},
);

const getOwnedMachine = (
	machineId: string,
	accountId: string,
): Effect.Effect<MachinePersistenceRecord, RelayError, MachineStore> =>
	Effect.gen(function* () {
		const store = yield* MachineStore;
		const machine = yield* store.getMachine(machineId);
		if (machine === null || machine.accountId !== accountId) {
			return yield* Effect.fail(notFound("machine_not_found"));
		}
		return machine;
	});

const ensureManualEntitlement = (
	accountId: string,
	offerId: string,
	nowMs: number,
): Effect.Effect<void, never, MachineStore> =>
	Effect.gen(function* () {
		const config = yield* MachineControlConfiguration;
		if (!config.manualEntitlementsEnabled) return;
		const store = yield* MachineStore;
		const entitlements = yield* store.listEntitlements(accountId);
		const active = entitlements.find(
			(entitlement) =>
				entitlement.offerId === offerId &&
				(entitlement.status === "pending" ||
					entitlement.status === "active" ||
					entitlement.status === "grace") &&
				(entitlement.paidThroughMs === undefined ||
					entitlement.paidThroughMs > nowMs),
		);
		if (active !== undefined) return;
		const entitlementId = yield* randomToken("ent", 12);
		yield* store.upsertEntitlement({
			entitlementId,
			accountId,
			kind: "persistent-machine",
			offerId,
			provider: "manual",
			status: "active",
			paidThroughMs: nowMs + 31 * 24 * 60 * 60 * 1_000,
			createdAtMs: nowMs,
			updatedAtMs: nowMs,
		});
	});

const enrollmentToken = (
	request: Request,
): Effect.Effect<string, RelayError> => {
	const authorization = request.headers.get("authorization");
	if (authorization?.startsWith("Bearer zenr_") !== true) {
		return Effect.fail(unauthorized("invalid_enrollment_token"));
	}
	return Effect.succeed(authorization.slice("Bearer ".length));
};

const enrollmentMachine = (
	request: Request,
	nowMs: number,
): Effect.Effect<
	{ readonly token: string; readonly machine: MachinePersistenceRecord },
	RelayError,
	MachineStore
> =>
	Effect.gen(function* () {
		const token = yield* enrollmentToken(request);
		const tokenHash = yield* sha256Hex(token);
		const store = yield* MachineStore;
		const machine = yield* store.findMachineByEnrollmentHash(tokenHash);
		if (machine === null) {
			return yield* Effect.fail(unauthorized("invalid_enrollment_token"));
		}
		if (
			machine.enrollmentExpiresAtMs === undefined ||
			machine.enrollmentExpiresAtMs <= nowMs
		) {
			return yield* Effect.fail(gone("enrollment_token_expired"));
		}
		const remainsActiveThroughPaidPeriod =
			machine.desiredState === "suspended" &&
			(machine.paidThroughMs ?? 0) > nowMs;
		if (
			(machine.desiredState !== "ready" && !remainsActiveThroughPaidPeriod) ||
			machine.state === "destroying" ||
			machine.state === "destroyed"
		) {
			return yield* Effect.fail(gone("enrollment_machine_inactive"));
		}
		return { token, machine };
	});

export const routeMachineRequest = (
	request: Request,
): Effect.Effect<Response | null, RelayError, MachineRouteContext> =>
	Effect.gen(function* () {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method.toUpperCase();
		const nowMs = yield* Clock.currentTimeMillis;
		const store = yield* MachineStore;

		if (method === "GET" && path === RelayPaths.billingCheckoutComplete) {
			return checkoutComplete();
		}

		const billingWebhookMatch = matchBillingWebhookPath(path);
		if (method === "POST" && billingWebhookMatch !== null) {
			const billingProviders = yield* BillingProviders;
			const { providerId } = billingWebhookMatch;
			if (
				providerId === undefined &&
				billingProviders.providerIds.length !== 1
			) {
				return yield* Effect.fail(badRequest("billing_provider_required"));
			}
			const billing = yield* (
				providerId === undefined
					? billingProviders.getDefault
					: billingProviders.get(providerId)
			).pipe(
				Effect.mapError(() =>
					serviceUnavailable("billing_provider_unavailable"),
				),
			);
			const event = yield* billing
				.verifyEvent(request)
				.pipe(Effect.mapError(() => unauthorized("invalid_billing_event")));
			const subscription = yield* billing
				.reconcileSubscription(event.subscriptionId)
				.pipe(
					Effect.mapError(() =>
						serviceUnavailable("billing_provider_unavailable"),
					),
				);
			const entitlementId = `ent_${(
				yield* sha256Hex(
					`${billing.providerId}:${subscription.providerSubscriptionId}`,
				)
			).slice(0, 24)}`;
			const entitlement: EntitlementPersistenceRecord = {
				entitlementId,
				accountId: subscription.accountId,
				kind: "persistent-machine",
				offerId: subscription.offerId,
				provider: billing.providerId,
				providerSubscriptionId: subscription.providerSubscriptionId,
				status: subscription.status,
				paidThroughMs: subscription.paidThrough,
				endedAtMs: subscription.status === "ended" ? nowMs : undefined,
				createdAtMs: nowMs,
				updatedAtMs: nowMs,
			};
			const machineConfig = yield* MachineControlConfiguration;
			const shouldProvision =
				subscription.status === "active" &&
				machineConfig.allowlistedAccountIds.has(subscription.accountId);
			const machineId = shouldProvision
				? yield* randomToken("machine", 12)
				: undefined;
			const providers = yield* MachineProviders;
			const provider = shouldProvision
				? yield* providers.getDefault.pipe(
						Effect.mapError(() =>
							serviceUnavailable("machine_provider_unavailable"),
						),
					)
				: undefined;
			const outcome = yield* store.applyBillingEvent({
				event: {
					provider: billing.providerId,
					eventId: event.eventId,
					nowMs,
				},
				entitlement,
				provisioning:
					machineId === undefined || provider === undefined
						? undefined
						: {
								machineId,
								idempotencyKey: `billing:${entitlementId}`,
								provider: provider.providerId,
								providerLabel: machineProviderLabel(machineId),
							},
				recoveryWindowMs: machineConfig.recoveryWindowMs,
			});
			const response = json({
				ok: true,
				duplicate: outcome.duplicate,
				provisioningQueued: outcome.machineCreated,
				machineId: outcome.machine?.machineId,
			});
			if (
				outcome.machine !== undefined &&
				(outcome.machineCreated || outcome.machine.state === "creating")
			) {
				response.headers.set(
					"x-zuse-reconcile-machine",
					outcome.machine.machineId,
				);
			}
			return response;
		}

		if (method === "POST" && path === RelayPaths.machineEnroll) {
			const { token, machine } = yield* enrollmentMachine(request, nowMs);
			const body = yield* decodeBody(MachineEnrollRequest, request);
			if (body.machineId !== machine.machineId) {
				return yield* Effect.fail(unauthorized("enrollment_machine_mismatch"));
			}
			if (
				body.origin.localHttpHost !== "127.0.0.1" ||
				!Number.isInteger(body.origin.localHttpPort) ||
				body.origin.localHttpPort < 1 ||
				body.origin.localHttpPort > 65_535
			) {
				return yield* Effect.fail(badRequest("invalid_tunnel_origin"));
			}
			if (
				machine.enrolledEnvironmentPublicKey !== undefined &&
				(machine.enrolledEnvironmentPublicKey !== body.environmentPublicKey ||
					machine.environmentId !== body.environmentId)
			) {
				return yield* Effect.fail(conflict("enrollment_identity_conflict"));
			}
			const config = yield* RelayConfiguration;
			const publicJwk = yield* parseJwk(body.environmentPublicKey);
			yield* verifyEnvironmentLinkProof({
				proof: body.proof,
				environmentPublicJwk: publicJwk,
				expectedChallenge: token,
				expectedEnvironmentId: body.environmentId,
				relayIssuer: config.relayIssuer,
			});

			const relayStore = yield* RelayStore;
			const claimed = yield* relayStore.registerEnvironment(
				{
					environmentId: body.environmentId,
					accountId: machine.accountId,
					providerKind: "cloud",
					label: body.label ?? machine.label,
					environmentPublicKey: body.environmentPublicKey,
					httpBaseUrl: body.endpoint.httpBaseUrl,
					wsBaseUrl: body.endpoint.wsBaseUrl,
					linkedAtMs: nowMs,
				},
				// An entitled managed machine has its own one-machine-per-account
				// limit. Do not strand an already-provisioned VPS behind the hosted
				// computer catalog limit.
				null,
				"preserve-identity",
			);
			if (!claimed) {
				return yield* Effect.fail(conflict("enrollment_identity_conflict"));
			}
			const tunnel = yield* ManagedTunnelProvider;
			if (!tunnel.enabled) {
				return yield* Effect.fail(
					serviceUnavailable("managed_tunnel_unavailable"),
				);
			}
			const provisioned = yield* tunnel.provision({
				accountId: machine.accountId,
				environmentId: body.environmentId,
				origin: body.origin,
			});
			yield* relayStore.setTunnelAllocation(body.environmentId, {
				tunnelHostname: provisioned.tunnelHostname,
				tunnelId: provisioned.tunnelId,
				dnsRecordId: provisioned.dnsRecordId,
				tunnelStatus: "ready",
			});
			const enrollmentTokenHash = machine.enrollmentTokenHash as string;
			let enrollmentBase = machine;
			let completed = false;
			for (let attempt = 0; attempt < 3 && !completed; attempt += 1) {
				const completedMachine: MachinePersistenceRecord = {
					...enrollmentBase,
					environmentId: body.environmentId,
					enrolledEnvironmentPublicKey: body.environmentPublicKey,
					state: "ready",
					statusCode:
						enrollmentBase.desiredState === "suspended"
							? "cancellation-scheduled"
							: "ready",
					stableFailureCode: undefined,
					attemptCount: 0,
					nextActionAtMs: Math.min(
						nowMs + 5 * 60 * 1_000,
						enrollmentBase.paidThroughMs ?? Number.MAX_SAFE_INTEGER,
					),
					updatedAtMs: nowMs,
				};
				completed = yield* store.completeEnrollment(
					completedMachine,
					enrollmentTokenHash,
					enrollmentBase.revision,
				);
				if (!completed) {
					const current = yield* store.getMachine(machine.machineId);
					if (
						current === null ||
						current.enrollmentTokenHash !== enrollmentTokenHash ||
						current.desiredState === "destroyed" ||
						current.state === "destroying" ||
						current.state === "destroyed"
					) {
						break;
					}
					enrollmentBase = current;
				}
			}
			if (!completed) {
				if (machine.enrolledEnvironmentPublicKey === undefined) {
					yield* tunnel
						.deprovision({
							tunnelId: provisioned.tunnelId,
							dnsRecordId: provisioned.dnsRecordId,
						})
						.pipe(Effect.ignore);
					yield* relayStore.deleteEnvironment(
						body.environmentId,
						machine.accountId,
					);
				}
				return yield* Effect.fail(gone("enrollment_machine_inactive"));
			}
			if (machine.enrolledEnvironmentPublicKey !== undefined) {
				yield* relayStore.revokeEnvironmentCredentials(
					body.environmentId,
					nowMs,
				);
			}
			const credentialSecret = yield* randomToken("zenv");
			const credentialId = yield* randomToken("cred", 8);
			yield* relayStore.insertCredential({
				credentialId,
				environmentId: body.environmentId,
				accountId: machine.accountId,
				credentialHash: yield* sha256Hex(credentialSecret),
				createdAtMs: nowMs,
			});

			return json({
				environmentId: body.environmentId,
				endpoint: {
					httpBaseUrl: `https://${provisioned.tunnelHostname}`,
					wsBaseUrl: `wss://${provisioned.tunnelHostname}`,
				},
				relayIssuer: config.relayIssuer,
				environmentCredential: credentialSecret,
				mintPublicKey: config.mintPublicKey,
				tunnelHostname: provisioned.tunnelHostname,
				connectorToken: provisioned.connectorToken,
			});
		}

		const bootMatch = /^\/v1\/machines\/([^/]+)\/boot-status$/.exec(path);
		if (method === "POST" && bootMatch !== null) {
			const { machine } = yield* enrollmentMachine(request, nowMs);
			const machineId = decodeURIComponent(bootMatch[1] ?? "");
			if (machine.machineId !== machineId) {
				return yield* Effect.fail(unauthorized("enrollment_machine_mismatch"));
			}
			const body = yield* decodeBody(MachineBootStatusRequest, request);
			const updated: MachinePersistenceRecord =
				machine.state === "ready" && body.phase !== "failed"
					? {
							...machine,
							bootPhase: body.phase,
							updatedAtMs: nowMs,
						}
					: body.phase === "failed"
						? {
								...machine,
								bootPhase: body.phase,
								state: "failed",
								statusCode: "bootstrap-failed",
								stableFailureCode: body.statusCode ?? "bootstrap-failed",
								nextActionAtMs: nowMs + 15 * 60 * 1_000,
								updatedAtMs: nowMs,
							}
						: body.phase === "service-started" ||
								body.phase === "zuse-started" ||
								body.phase === "account-setup-available"
							? {
									...machine,
									bootPhase: body.phase,
									state: "enrolling",
									statusCode: "enrollment-pending",
									nextActionAtMs: nowMs + 60_000,
									updatedAtMs: nowMs,
								}
							: {
									...machine,
									bootPhase: body.phase,
									state: "bootstrapping",
									statusCode: "bootstrap-pending",
									nextActionAtMs: nowMs + 60_000,
									updatedAtMs: nowMs,
								};
			const saved = yield* store.compareAndSetMachine(
				updated,
				machine.revision,
			);
			if (!saved) {
				const current = yield* store.getMachine(machine.machineId);
				if (current === null) {
					return yield* Effect.fail(gone("enrollment_machine_inactive"));
				}
				return json(toPublicMachine(current));
			}
			return json(toPublicMachine(updated));
		}

		if (method === "GET" && path === RelayPaths.machineOffers) {
			yield* requireMachineAlphaPrincipal(request);
			return json({ offers: MACHINE_OFFERS });
		}

		if (method === "GET" && path === RelayPaths.machines) {
			const principal = yield* requireMachineAlphaPrincipal(request);
			const machines = yield* store.listMachines(principal.accountId);
			return json({ machines: machines.map(toPublicMachine) });
		}

		if (method === "POST" && path === RelayPaths.machines) {
			const principal = yield* requireMachineAlphaPrincipal(request);
			const body = yield* decodeBody(MachineCreateRequest, request);
			const offer = findMachineOffer(body.offerId);
			if (offer === undefined || !offer.available) {
				return yield* Effect.fail(badRequest("invalid_machine_offer"));
			}
			yield* ensureManualEntitlement(principal.accountId, offer.offerId, nowMs);
			const machineId = yield* randomToken("machine", 12);
			const providers = yield* MachineProviders;
			const provider = yield* providers.getDefault.pipe(
				Effect.mapError(() =>
					serviceUnavailable("machine_provider_unavailable"),
				),
			);
			const outcome = yield* store.createMachine({
				accountId: principal.accountId,
				offerId: offer.offerId,
				idempotencyKey: body.idempotencyKey,
				machineId,
				provider: provider.providerId,
				providerLabel: machineProviderLabel(machineId),
				label: body.label,
				nowMs,
			});
			if (outcome.kind === "entitlement-required") {
				return yield* Effect.fail(forbidden("entitlement_required"));
			}
			if (outcome.kind === "machine-limit-reached") {
				return yield* Effect.fail(conflict("machine_limit_reached"));
			}
			const response = json(
				toPublicMachine(outcome.machine),
				outcome.kind === "created" ? 201 : 200,
			);
			if (outcome.kind === "created" || outcome.machine.state === "creating") {
				response.headers.set(
					"x-zuse-reconcile-machine",
					outcome.machine.machineId,
				);
			}
			return response;
		}

		if (method === "GET" && path === RelayPaths.billingEntitlements) {
			const principal = yield* requireMachineAlphaPrincipal(request);
			const entitlements = yield* store.listEntitlements(principal.accountId);
			const machines = yield* store.listMachines(principal.accountId);
			return json({
				entitlements: entitlements.map((entitlement) => ({
					...toPublicEntitlement(entitlement),
					machineId: machines.find(
						(machine) =>
							machine.entitlementId === entitlement.entitlementId &&
							machine.state !== "destroyed",
					)?.machineId,
				})),
			});
		}

		if (method === "POST" && path === RelayPaths.billingCheckout) {
			const principal = yield* requireMachineAlphaPrincipal(request);
			const body = yield* decodeBody(BillingCheckoutRequest, request);
			if (findMachineOffer(body.offerId) === undefined) {
				return yield* Effect.fail(badRequest("invalid_machine_offer"));
			}
			const machineConfig = yield* MachineControlConfiguration;
			if (!machineConfig.liveCheckoutEnabled) {
				return yield* Effect.fail(
					serviceUnavailable("billing_approval_pending"),
				);
			}
			const [entitlements, machines] = yield* Effect.all([
				store.listEntitlements(principal.accountId),
				store.listMachines(principal.accountId),
			]);
			const alreadySubscribed =
				entitlements.some(
					(entitlement) =>
						entitlement.offerId === body.offerId &&
						(entitlement.status === "pending" ||
							entitlement.status === "active" ||
							entitlement.status === "grace") &&
						(entitlement.paidThroughMs === undefined ||
							entitlement.paidThroughMs > nowMs),
				) || machines.some((machine) => machine.state !== "destroyed");
			if (alreadySubscribed) {
				return yield* Effect.fail(conflict("machine_subscription_exists"));
			}
			const billingProviders = yield* BillingProviders;
			const relayConfig = yield* RelayConfiguration;
			const billing = yield* billingProviders.getDefault.pipe(
				Effect.mapError(() =>
					serviceUnavailable("billing_provider_unavailable"),
				),
			);
			const checkoutUrl = yield* billing
				.checkout({
					accountId: principal.accountId,
					offerId: body.offerId,
					successUrl: new URL(
						RelayPaths.billingCheckoutComplete,
						relayConfig.relayIssuer,
					).toString(),
				})
				.pipe(
					Effect.mapError(() =>
						serviceUnavailable("billing_provider_unavailable"),
					),
				);
			return json({ checkoutUrl });
		}

		if (method === "POST" && path === RelayPaths.billingPortal) {
			const principal = yield* requireMachineAlphaPrincipal(request);
			const entitlements = yield* store.listEntitlements(principal.accountId);
			const portalProviderIds = [
				...new Set(
					entitlements
						.filter(
							(entitlement) => entitlement.providerSubscriptionId !== undefined,
						)
						.map((entitlement) => entitlement.provider),
				),
			];
			if (portalProviderIds.length > 1) {
				return yield* Effect.fail(conflict("billing_provider_ambiguous"));
			}
			const billingProviders = yield* BillingProviders;
			const billing = yield* (
				portalProviderIds[0] === undefined
					? billingProviders.getDefault
					: billingProviders.get(portalProviderIds[0])
			).pipe(
				Effect.mapError(() =>
					serviceUnavailable("billing_provider_unavailable"),
				),
			);
			const portalUrl = yield* billing
				.customerPortal(principal.accountId)
				.pipe(
					Effect.mapError(() =>
						serviceUnavailable("billing_provider_unavailable"),
					),
				);
			return json({ portalUrl });
		}

		const machineMatch = /^\/v1\/machines\/([^/]+)$/.exec(path);
		if (method === "GET" && machineMatch !== null) {
			const principal = yield* requireMachineAlphaPrincipal(request);
			const machine = yield* getOwnedMachine(
				decodeURIComponent(machineMatch[1] ?? ""),
				principal.accountId,
			);
			return json(toPublicMachine(machine));
		}

		const cancelMatch = /^\/v1\/machines\/([^/]+)\/cancel$/.exec(path);
		if (method === "POST" && cancelMatch !== null) {
			const principal = yield* requireMachineAlphaPrincipal(request);
			const machine = yield* getOwnedMachine(
				decodeURIComponent(cancelMatch[1] ?? ""),
				principal.accountId,
			);
			if (
				machine.state === "destroyed" ||
				machine.desiredState === "destroyed"
			) {
				return yield* Effect.fail(conflict("invalid_machine_state"));
			}
			const config = yield* MachineControlConfiguration;
			const paidThroughMs = machine.paidThroughMs ?? nowMs;
			const updated: MachinePersistenceRecord = {
				...machine,
				desiredState: "suspended",
				statusCode: "cancellation-scheduled",
				paidThroughMs,
				recoveryDeadlineMs: paidThroughMs + config.recoveryWindowMs,
				nextActionAtMs: nowMs,
				updatedAtMs: nowMs,
			};
			const saved = yield* store.compareAndSetMachine(
				updated,
				machine.revision,
			);
			if (!saved) return yield* Effect.fail(conflict("machine_state_changed"));
			return json(toPublicMachine(updated));
		}

		const recoverMatch = /^\/v1\/machines\/([^/]+)\/recover$/.exec(path);
		if (method === "POST" && recoverMatch !== null) {
			const principal = yield* requireMachineAlphaPrincipal(request);
			const machine = yield* getOwnedMachine(
				decodeURIComponent(recoverMatch[1] ?? ""),
				principal.accountId,
			);
			if (
				machine.state !== "suspended" ||
				machine.recoveryDeadlineMs === undefined ||
				machine.recoveryDeadlineMs <= nowMs
			) {
				return yield* Effect.fail(conflict("machine_not_recoverable"));
			}
			yield* ensureManualEntitlement(
				principal.accountId,
				machine.offerId,
				nowMs,
			);
			const entitlements = yield* store.listEntitlements(principal.accountId);
			const renewed = entitlements.find(
				(entitlement) =>
					entitlement.offerId === machine.offerId &&
					entitlement.status === "active" &&
					(entitlement.paidThroughMs ?? 0) > nowMs,
			);
			if (renewed === undefined) {
				return yield* Effect.fail(forbidden("entitlement_required"));
			}
			const updated: MachinePersistenceRecord = {
				...machine,
				entitlementId: renewed.entitlementId,
				state: "resuming",
				desiredState: "ready",
				statusCode: "resume-queued",
				paidThroughMs: renewed.paidThroughMs,
				recoveryDeadlineMs: undefined,
				nextActionAtMs: nowMs,
				updatedAtMs: nowMs,
			};
			const saved = yield* store.compareAndSetMachine(
				updated,
				machine.revision,
			);
			if (!saved) return yield* Effect.fail(conflict("machine_state_changed"));
			return json(toPublicMachine(updated));
		}

		const destroyMatch = /^\/v1\/machines\/([^/]+)\/destroy$/.exec(path);
		if (method === "POST" && destroyMatch !== null) {
			const principal = yield* requireMachineAlphaPrincipal(request);
			const body = yield* decodeBody(MachineDestroyRequest, request);
			const pathMachineId = decodeURIComponent(destroyMatch[1] ?? "");
			if (body.machineId !== pathMachineId) {
				return yield* Effect.fail(badRequest("machine_id_mismatch"));
			}
			const machine = yield* getOwnedMachine(
				pathMachineId,
				principal.accountId,
			);
			if (machine.state === "destroyed") return json(toPublicMachine(machine));
			const updated = requestMachineDestruction(machine, nowMs);
			const saved = yield* store.compareAndSetMachine(
				updated,
				machine.revision,
			);
			if (!saved) {
				const current = yield* store.getMachine(machine.machineId);
				if (
					current?.state === "destroyed" ||
					current?.desiredState === "destroyed"
				) {
					return json(toPublicMachine(current));
				}
				return yield* Effect.fail(conflict("machine_state_changed"));
			}
			if (machine.environmentId !== undefined) {
				const relayStore = yield* RelayStore;
				yield* relayStore.revokeEnvironmentCredentials(
					machine.environmentId,
					nowMs,
				);
			}
			const entitlements = yield* store.listEntitlements(principal.accountId);
			const entitlement = entitlements.find(
				(item) => item.entitlementId === machine.entitlementId,
			);
			if (entitlement?.providerSubscriptionId !== undefined) {
				yield* cancelProviderSubscription({
					providerId: entitlement.provider,
					providerSubscriptionId: entitlement.providerSubscriptionId,
				}).pipe(Effect.ignore);
			}
			return json(toPublicMachine(updated));
		}

		return null;
	});
