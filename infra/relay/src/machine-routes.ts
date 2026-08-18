import {
	BillingProviders,
	type CheckoutSummary,
	type ReconciledSubscription,
} from "@zuse/billing-providers";
import {
	BillingCheckoutRequest,
	CLOUD_WORKSPACE_OFFER_ID,
	type MachineBootPhase,
	MachineBootStatusRequest,
	MachineCreateRequest,
	MachineDestroyRequest,
	MachineEnrollRequest,
	type MachineRecord,
	RelayPaths,
} from "@zuse/contracts";
import { MachineProviders } from "@zuse/machine-providers";
import { BROWSER_PAGE_HEADERS } from "@zuse/utils/browser-page";
import { Clock, Effect, Redacted, Schema } from "effect";
import { AccountIdentity } from "./account-identity.ts";
import { requireWorkos } from "./auth.ts";
import {
	type BetaAccess,
	ensureCloudBetaAccess,
	requireCloudBetaAccess,
} from "./beta-access.ts";
import { cancelProviderSubscription } from "./billing-operations.ts";
import { renderCheckoutCompletePage } from "./checkout-complete-page.ts";
import { ensureCloudBillingPeriod } from "./cloud-billing-period.ts";
import type { CloudBillingStore } from "./cloud-billing-store.ts";
import { RelayConfiguration } from "./config.ts";
import {
	parseJwk,
	randomToken,
	sha256Hex,
	signCheckoutReceiptTicket,
	verifyCheckoutReceiptTicket,
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
import {
	findMachineOffer,
	MACHINE_OFFERS,
	offerIdsOfKind,
} from "./machine-offers.ts";
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
	| AccountIdentity
	| BetaAccess
	| MachineStore
	| MachineProviders
	| BillingProviders
	| RelayConfiguration
	| RelayStore
	| ManagedTunnelProvider
	| CloudBillingStore;

const persistentProviderId = Effect.fn("persistentProviderId")(function* () {
	return (yield* (yield* MachineProviders).getDefault).providerId;
});

const offerIsAvailable = (
	offerId: string,
	config: { readonly availableOfferIds?: ReadonlySet<string> },
): boolean =>
	(findMachineOffer(offerId)?.available ?? false) &&
	(config.availableOfferIds?.has(offerId) ?? true);

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

/** Polar substitutes this in the success URL; treat an unsubstituted one as absent. */
const CHECKOUT_ID_PLACEHOLDER = "{CHECKOUT_ID}";
const CHECKOUT_ID_MAX_LENGTH = 128;

/** How long the completion page will still show a real order. */
const CHECKOUT_RECEIPT_TICKET_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * Where the provider sends the customer after payment. `ticket` is the
 * relay-signed proof of which account started this checkout — the completion
 * page is unauthenticated, so it is the only thing that authorizes an order
 * lookup. `{CHECKOUT_ID}` is interpolated by the provider and must not be
 * URL-encoded.
 */
export const checkoutSuccessUrl = (
	issuer: string,
	offerId: string,
	ticket: string,
): string => {
	const target = new URL(RelayPaths.billingCheckoutComplete, issuer);
	target.searchParams.set("offer", offerId);
	target.searchParams.set("t", ticket);
	return `${target.toString()}&checkout_id=${CHECKOUT_ID_PLACEHOLDER}`;
};

/** Offers the checkout-complete page will name. Anything else renders generic. */
const knownOfferId = (offerId: string | null): string | null =>
	offerId !== null &&
	(offerId === CLOUD_WORKSPACE_OFFER_ID ||
		findMachineOffer(offerId) !== undefined)
		? offerId
		: null;

const catalogProductName = (offerId: string | null): string =>
	offerId === CLOUD_WORKSPACE_OFFER_ID
		? "Zuse Cloud Workspace"
		: (findMachineOffer(offerId ?? "")?.displayName ?? "Zuse subscription");

const orderReference = (checkoutId: string): string =>
	`ZS-${checkoutId
		.replaceAll(/[^A-Za-z0-9]/gu, "")
		.slice(-8)
		.toUpperCase()}`;

/**
 * Best-effort order lookup for the post-purchase page. The account comes from
 * the verified receipt ticket, never from the query string, and the adapter
 * drops checkouts owned by anyone else. The page is a courtesy surface, so a
 * slow or unavailable billing provider degrades to the offer catalog instead of
 * failing the response.
 */
const lookupCheckoutSummary = (input: {
	readonly checkoutId: string;
	readonly accountId: string;
}): Effect.Effect<CheckoutSummary | null, never, BillingProviders> =>
	Effect.gen(function* () {
		const billingProviders = yield* BillingProviders;
		const billing = yield* billingProviders.getDefault;
		return yield* billing.getCheckout(input);
	}).pipe(
		Effect.timeout("2 seconds"),
		Effect.orElseSucceed(() => null),
	);

const checkoutComplete = (input: {
	readonly offerId: string | null;
	readonly summary: CheckoutSummary | null;
}): Response => {
	const offer = findMachineOffer(input.offerId ?? "");
	const catalogAmount =
		offer === undefined
			? undefined
			: { cents: offer.monthlyPriceCents, currency: offer.currency };
	// Only an order the ticket holder owns gets a reference printed on it.
	const orderRef =
		input.summary === null
			? undefined
			: orderReference(input.summary.checkoutId);
	return new Response(
		renderCheckoutCompletePage({
			...(input.summary?.amountCents === undefined
				? catalogAmount === undefined
					? {}
					: { amount: catalogAmount }
				: {
						amount: {
							cents: input.summary.amountCents,
							currency: input.summary.currency,
						},
					}),
			...(orderRef === undefined ? {} : { orderRef }),
			...(input.summary === null
				? {}
				: { purchasedAtMs: input.summary.createdAtMs }),
			productName:
				input.summary?.productName ?? catalogProductName(input.offerId),
			status: input.summary?.status ?? "pending",
		}),
		{ status: 200, headers: { ...BROWSER_PAGE_HEADERS } },
	);
};

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

const hasReportedHealthyRuntime = (
	phase: MachineBootPhase | undefined,
): boolean => phase === "zuse-started" || phase === "account-setup-available";

const markMachineReady = (
	machine: MachinePersistenceRecord,
	nowMs: number,
): MachinePersistenceRecord => ({
	...machine,
	state: "ready",
	statusCode:
		machine.desiredState === "suspended" ? "cancellation-scheduled" : "ready",
	stableFailureCode: undefined,
	attemptCount: 0,
	nextActionAtMs: Math.min(
		nowMs + 5 * 60 * 1_000,
		machine.paidThroughMs ?? Number.MAX_SAFE_INTEGER,
	),
	updatedAtMs: nowMs,
});

const bootPhaseOrder = new Map<MachineBootPhase, number>([
	["bootstrap-started", 0],
	["runtime-installed", 1],
	["developer-tools-installed", 2],
	["service-started", 3],
	["zuse-started", 4],
	["account-setup-available", 5],
]);

const isDuplicateOrStaleBootPhase = (
	machine: MachinePersistenceRecord,
	phase: MachineBootPhase,
): boolean => {
	if (machine.bootPhase === undefined) return false;
	const currentOrder = bootPhaseOrder.get(machine.bootPhase);
	if (phase === "failed") {
		return (
			machine.state === "ready" ||
			machine.bootPhase === "failed" ||
			(currentOrder ?? -1) >= (bootPhaseOrder.get("zuse-started") ?? 4)
		);
	}
	const nextOrder = bootPhaseOrder.get(phase);
	return (
		currentOrder !== undefined &&
		nextOrder !== undefined &&
		nextOrder <= currentOrder
	);
};

const applyBootStatus = (
	machine: MachinePersistenceRecord,
	body: MachineBootStatusRequest,
	nowMs: number,
): MachinePersistenceRecord => {
	if (machine.state === "ready" && body.phase !== "failed") {
		return {
			...machine,
			bootPhase: body.phase,
			updatedAtMs: nowMs,
		};
	}
	if (body.phase === "failed") {
		return {
			...machine,
			bootPhase: body.phase,
			state: "failed",
			statusCode: "bootstrap-failed",
			stableFailureCode: body.statusCode ?? "bootstrap-failed",
			nextActionAtMs: nowMs + 15 * 60 * 1_000,
			updatedAtMs: nowMs,
		};
	}
	const progress = {
		...machine,
		bootPhase: body.phase,
		stableFailureCode: undefined,
		lastError: undefined,
		updatedAtMs: nowMs,
	};
	if (
		machine.environmentId !== undefined &&
		machine.enrolledEnvironmentPublicKey !== undefined &&
		hasReportedHealthyRuntime(body.phase)
	) {
		return markMachineReady(progress, nowMs);
	}
	if (
		machine.environmentId !== undefined ||
		body.phase === "service-started" ||
		body.phase === "zuse-started" ||
		body.phase === "account-setup-available"
	) {
		return {
			...progress,
			state: "enrolling",
			statusCode: "enrollment-pending",
			nextActionAtMs: nowMs + 60_000,
		};
	}
	return {
		...progress,
		state: "bootstrapping",
		statusCode: "bootstrap-pending",
		nextActionAtMs: nowMs + 60_000,
	};
};

const toPublicEntitlement = (entitlement: EntitlementPersistenceRecord) => ({
	entitlementId: entitlement.entitlementId,
	kind: entitlement.kind,
	status: entitlement.status,
	offerId: entitlement.offerId,
	paidThrough: entitlement.paidThroughMs,
});

const reconcileCheckoutEntitlements = (
	accountId: string,
	entitlements: ReadonlyArray<EntitlementPersistenceRecord>,
	nowMs: number,
): Effect.Effect<
	ReadonlyArray<EntitlementPersistenceRecord>,
	RelayError,
	BillingProviders | MachineStore
> =>
	Effect.gen(function* () {
		const billingProviders = yield* BillingProviders;
		const store = yield* MachineStore;
		return yield* Effect.forEach(
			entitlements,
			(entitlement) => {
				const providerSubscriptionId = entitlement.providerSubscriptionId;
				if (
					providerSubscriptionId === undefined ||
					entitlement.status === "ended"
				) {
					return Effect.succeed(entitlement);
				}
				return Effect.gen(function* () {
					const billing = yield* billingProviders
						.get(entitlement.provider)
						.pipe(
							Effect.mapError(() =>
								serviceUnavailable("billing_provider_unavailable"),
							),
						);
					const subscription = yield* billing
						.reconcileSubscription(providerSubscriptionId)
						.pipe(
							Effect.mapError(() =>
								serviceUnavailable("billing_provider_unavailable"),
							),
						);
					if (
						subscription.accountId !== accountId ||
						subscription.providerSubscriptionId !== providerSubscriptionId ||
						subscription.offerId !== entitlement.offerId
					) {
						return yield* Effect.fail(
							serviceUnavailable("billing_subscription_mismatch"),
						);
					}
					const reconciled: EntitlementPersistenceRecord = {
						...entitlement,
						status: subscription.status,
						paidThroughMs: subscription.paidThrough,
						endedAtMs:
							subscription.status === "ended" &&
							(subscription.paidThrough ?? 0) <= nowMs
								? (entitlement.endedAtMs ?? nowMs)
								: undefined,
						updatedAtMs: nowMs,
					};
					yield* store.upsertEntitlement(reconciled);
					return reconciled;
				});
			},
			{ concurrency: 4 },
		);
	});

const applyBillingSubscription = Effect.fn("applyBillingSubscription")(
	function* (input: {
		readonly billingProviderId: string;
		readonly eventId: string;
		readonly nowMs: number;
		readonly subscription: ReconciledSubscription;
	}) {
		const store = yield* MachineStore;
		const machineConfig = yield* MachineControlConfiguration;
		const { subscription } = input;
		const entitlementId = `ent_${(
			yield* sha256Hex(
				`${input.billingProviderId}:${subscription.providerSubscriptionId}`,
			)
		).slice(0, 24)}`;
		const offer =
			subscription.offerId === CLOUD_WORKSPACE_OFFER_ID
				? undefined
				: findMachineOffer(subscription.offerId);
		const shouldProvision =
			subscription.status === "active" &&
			offer !== undefined &&
			machineConfig.allowlistedAccountIds.has(subscription.accountId);
		const machineId = shouldProvision
			? yield* randomToken("machine", 12)
			: undefined;
		const computeProviderId = shouldProvision
			? yield* persistentProviderId().pipe(
					Effect.mapError(() =>
						serviceUnavailable("machine_provider_unavailable"),
					),
				)
			: undefined;
		const outcome = yield* store.applyBillingEvent({
			sameKindOfferIds: offer === undefined ? [] : offerIdsOfKind(offer.kind),
			event: {
				provider: input.billingProviderId,
				eventId: input.eventId,
				nowMs: input.nowMs,
			},
			entitlement: {
				entitlementId,
				accountId: subscription.accountId,
				kind:
					subscription.offerId === CLOUD_WORKSPACE_OFFER_ID
						? "cloud-workspace"
						: "persistent-machine",
				offerId: subscription.offerId,
				provider: input.billingProviderId,
				providerSubscriptionId: subscription.providerSubscriptionId,
				status: subscription.status,
				periodStartMs: subscription.periodStart,
				paidThroughMs: subscription.paidThrough,
				endedAtMs:
					subscription.status === "ended" &&
					(subscription.paidThrough === undefined ||
						subscription.paidThrough <= input.nowMs)
						? input.nowMs
						: undefined,
				createdAtMs: input.nowMs,
				updatedAtMs: input.nowMs,
			},
			provisioning:
				machineId === undefined || computeProviderId === undefined
					? undefined
					: {
							machineId,
							idempotencyKey: `billing:${entitlementId}`,
							provider: computeProviderId,
							providerLabel: machineProviderLabel(machineId),
						},
			recoveryWindowMs: machineConfig.recoveryWindowMs,
		});
		if (
			subscription.offerId === CLOUD_WORKSPACE_OFFER_ID &&
			subscription.periodStart !== undefined &&
			subscription.paidThrough !== undefined
		) {
			yield* ensureCloudBillingPeriod({
				accountId: subscription.accountId,
				provider: input.billingProviderId,
				providerSubscriptionId: subscription.providerSubscriptionId,
				subscriptionStatus: subscription.status,
				periodStartMs: subscription.periodStart,
				periodEndMs: subscription.paidThrough,
				nowMs: input.nowMs,
			});
		}
		return outcome;
	},
);

const claimCheckoutLinkSubscriptions = Effect.fn(
	"claimCheckoutLinkSubscriptions",
)(function* (accountId: string, nowMs: number) {
	const identity = yield* AccountIdentity;
	const email = yield* identity.verifiedEmail(accountId);
	if (email === null) return;
	const billing = yield* (yield* BillingProviders).getDefault.pipe(
		Effect.mapError(() => serviceUnavailable("billing_provider_unavailable")),
	);
	if (billing.claimSubscriptions === undefined) return;
	const subscriptionIds = yield* billing
		.claimSubscriptions({ accountId, verifiedEmail: email })
		.pipe(
			Effect.mapError(() => serviceUnavailable("billing_provider_unavailable")),
		);
	for (const subscriptionId of subscriptionIds) {
		const subscription = yield* billing
			.reconcileSubscription(subscriptionId)
			.pipe(
				Effect.mapError(() =>
					serviceUnavailable("billing_provider_unavailable"),
				),
			);
		if (
			subscription.accountId !== accountId ||
			subscription.offerId !== CLOUD_WORKSPACE_OFFER_ID
		)
			continue;
		yield* applyBillingSubscription({
			billingProviderId: billing.providerId,
			eventId: `claim:${accountId}:${subscriptionId}`,
			nowMs,
			subscription,
		});
	}
});

const requireHostedPrincipal = Effect.fn("requireHostedPrincipal")(function* (
	request: Request,
) {
	const principal = yield* requireWorkos(request);
	yield* requireCloudBetaAccess(principal.accountId);
	return principal;
});

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
			// Anyone can open this URL, so the page is rendered from the relay's own
			// signed ticket: without it (or with an expired one) the visitor gets the
			// generic catalog receipt and no provider lookup happens at all.
			const relayConfig = yield* RelayConfiguration;
			const ticketParam = url.searchParams.get("t");
			const ticket =
				ticketParam === null
					? null
					: yield* parseJwk(relayConfig.mintPublicKey).pipe(
							Effect.flatMap((mintPublicJwk) =>
								verifyCheckoutReceiptTicket({
									issuer: relayConfig.relayIssuer,
									mintPublicJwk,
									nowMs,
									token: ticketParam,
								}),
							),
							Effect.orElseSucceed(() => null),
						);
			const checkoutParam = url.searchParams.get("checkout_id");
			const checkoutId =
				checkoutParam === null ||
				checkoutParam === CHECKOUT_ID_PLACEHOLDER ||
				checkoutParam.length === 0 ||
				checkoutParam.length > CHECKOUT_ID_MAX_LENGTH
					? null
					: checkoutParam;
			const summary =
				ticket === null || checkoutId === null
					? null
					: yield* lookupCheckoutSummary({
							accountId: ticket.accountId,
							checkoutId,
						});
			return checkoutComplete({
				offerId: knownOfferId(ticket?.offerId ?? url.searchParams.get("offer")),
				summary,
			});
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
			const outcome = yield* applyBillingSubscription({
				billingProviderId: billing.providerId,
				eventId: event.eventId,
				nowMs,
				subscription,
			});
			const response = json({
				ok: true,
				duplicate: outcome.duplicate,
				provisioningQueued: outcome.machineCreated,
				machineId: outcome.machine?.machineId,
			});
			if (
				outcome.machine !== undefined &&
				(outcome.machineCreated ||
					outcome.machine.state === "creating" ||
					outcome.machine.state === "resuming")
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
			const endpoint = {
				httpBaseUrl: `https://${provisioned.tunnelHostname}`,
				wsBaseUrl: `wss://${provisioned.tunnelHostname}`,
			};
			const claimed = yield* relayStore.registerEnvironment(
				{
					environmentId: body.environmentId,
					accountId: machine.accountId,
					providerKind: "cloud",
					label: body.label ?? machine.label,
					environmentPublicKey: body.environmentPublicKey,
					httpBaseUrl: endpoint.httpBaseUrl,
					wsBaseUrl: endpoint.wsBaseUrl,
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
				const enrolledMachine: MachinePersistenceRecord = {
					...enrollmentBase,
					environmentId: body.environmentId,
					enrolledEnvironmentPublicKey: body.environmentPublicKey,
					state: "enrolling",
					statusCode:
						enrollmentBase.desiredState === "suspended"
							? "cancellation-scheduled"
							: "enrollment-pending",
					stableFailureCode: undefined,
					attemptCount: 0,
					nextActionAtMs: nowMs + 60_000,
					updatedAtMs: nowMs,
				};
				const completedMachine = hasReportedHealthyRuntime(
					enrollmentBase.bootPhase,
				)
					? markMachineReady(enrolledMachine, nowMs)
					: enrolledMachine;
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
					const tunnel = yield* ManagedTunnelProvider;
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
				endpoint,
				relayIssuer: config.relayIssuer,
				environmentCredential: credentialSecret,
				mintPublicKey: config.mintPublicKey,
				tunnelHostname: provisioned?.tunnelHostname,
				connectorToken: provisioned?.connectorToken,
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
			const enrollmentTokenHash = machine.enrollmentTokenHash;
			let current = machine;
			for (let attempt = 0; attempt < 3; attempt += 1) {
				if (isDuplicateOrStaleBootPhase(current, body.phase)) {
					return json(toPublicMachine(current));
				}
				const updated = applyBootStatus(current, body, nowMs);
				const saved = yield* store.compareAndSetMachine(
					updated,
					current.revision,
				);
				if (saved) return json(toPublicMachine(updated));
				const reloaded = yield* store.getMachine(machine.machineId);
				if (
					reloaded === null ||
					reloaded.enrollmentTokenHash !== enrollmentTokenHash ||
					reloaded.desiredState === "destroyed" ||
					reloaded.state === "destroying" ||
					reloaded.state === "destroyed"
				) {
					return yield* Effect.fail(gone("enrollment_machine_inactive"));
				}
				current = reloaded;
			}
			return yield* Effect.fail(conflict("machine_state_changed"));
		}

		if (method === "GET" && path === RelayPaths.machineOffers) {
			yield* requireHostedPrincipal(request);
			const machineConfig = yield* MachineControlConfiguration;
			return json({
				offers: MACHINE_OFFERS.map((offer) => ({
					...offer,
					available: offerIsAvailable(offer.offerId, machineConfig),
				})),
			});
		}

		if (method === "GET" && path === RelayPaths.machines) {
			const principal = yield* requireHostedPrincipal(request);
			const machines = yield* store.listMachines(principal.accountId);
			return json({ machines: machines.map(toPublicMachine) });
		}

		if (method === "POST" && path === RelayPaths.machines) {
			const principal = yield* requireHostedPrincipal(request);
			const body = yield* decodeBody(MachineCreateRequest, request);
			const offer = findMachineOffer(body.offerId);
			const machineConfig = yield* MachineControlConfiguration;
			if (
				offer === undefined ||
				!offerIsAvailable(offer.offerId, machineConfig)
			) {
				return yield* Effect.fail(badRequest("invalid_machine_offer"));
			}
			yield* ensureManualEntitlement(principal.accountId, offer.offerId, nowMs);
			const machineId = yield* randomToken("machine", 12);
			const providerId = yield* persistentProviderId().pipe(
				Effect.mapError(() =>
					serviceUnavailable("machine_provider_unavailable"),
				),
			);
			const outcome = yield* store.createMachine({
				accountId: principal.accountId,
				offerId: offer.offerId,
				sameKindOfferIds: offerIdsOfKind(offer.kind),
				idempotencyKey: body.idempotencyKey,
				machineId,
				provider: providerId,
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
			const principal = yield* requireWorkos(request);
			let entitlements = yield* store.listEntitlements(principal.accountId);
			if (
				!entitlements.some(
					(entitlement) =>
						entitlement.offerId === CLOUD_WORKSPACE_OFFER_ID &&
						entitlement.status !== "ended",
				)
			) {
				yield* claimCheckoutLinkSubscriptions(principal.accountId, nowMs);
				entitlements = yield* store.listEntitlements(principal.accountId);
			}
			if (
				entitlements.some(
					(entitlement) =>
						entitlement.offerId === CLOUD_WORKSPACE_OFFER_ID &&
						entitlement.status === "active",
				)
			) {
				yield* ensureCloudBetaAccess(principal.accountId);
			}
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
			const principal = yield* requireHostedPrincipal(request);
			const body = yield* decodeBody(BillingCheckoutRequest, request);
			const machineConfig = yield* MachineControlConfiguration;
			const isCloudWorkspace = body.offerId === CLOUD_WORKSPACE_OFFER_ID;
			const offer = findMachineOffer(body.offerId);
			if (
				(!isCloudWorkspace && offer === undefined) ||
				!(machineConfig.liveCheckoutOfferIds?.has(body.offerId) ?? true)
			) {
				return yield* Effect.fail(badRequest("invalid_machine_offer"));
			}
			if (
				!machineConfig.liveCheckoutEnabled ||
				!(machineConfig.liveCheckoutOfferIds?.has(body.offerId) ?? true)
			) {
				return yield* Effect.fail(
					serviceUnavailable("billing_approval_pending"),
				);
			}
			const [storedEntitlements, machines] = yield* Effect.all([
				store.listEntitlements(principal.accountId),
				store.listMachines(principal.accountId),
			]);
			const entitlements = yield* reconcileCheckoutEntitlements(
				principal.accountId,
				storedEntitlements,
				nowMs,
			);
			const alreadySubscribed =
				entitlements.some(
					(entitlement) =>
						entitlement.offerId === body.offerId &&
						(entitlement.status === "pending" ||
							entitlement.status === "active" ||
							entitlement.status === "grace") &&
						(entitlement.paidThroughMs === undefined ||
							entitlement.paidThroughMs > nowMs),
				) ||
				(!isCloudWorkspace &&
					machines.some(
						(machine) =>
							offerIdsOfKind(
								findMachineOffer(body.offerId)?.kind ?? "persistent",
							).includes(machine.offerId) &&
							machine.state !== "destroyed" &&
							!(
								machine.state === "suspended" &&
								machine.recoveryDeadlineMs !== undefined &&
								machine.recoveryDeadlineMs > nowMs
							),
					));
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
			const receiptTicket = yield* signCheckoutReceiptTicket({
				accountId: principal.accountId,
				issuer: relayConfig.relayIssuer,
				mintPrivateJwk: yield* parseJwk(
					Redacted.value(relayConfig.mintPrivateKey),
				),
				nowMs,
				offerId: body.offerId,
				ttlMs: CHECKOUT_RECEIPT_TICKET_TTL_MS,
			});
			const checkoutUrl = yield* billing
				.checkout({
					accountId: principal.accountId,
					offerId: body.offerId,
					successUrl: checkoutSuccessUrl(
						relayConfig.relayIssuer,
						body.offerId,
						receiptTicket,
					),
				})
				.pipe(
					Effect.mapError(() =>
						serviceUnavailable("billing_provider_unavailable"),
					),
				);
			return json({ checkoutUrl });
		}

		if (method === "POST" && path === RelayPaths.billingPortal) {
			const principal = yield* requireWorkos(request);
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
			const principal = yield* requireHostedPrincipal(request);
			const machine = yield* getOwnedMachine(
				decodeURIComponent(machineMatch[1] ?? ""),
				principal.accountId,
			);
			return json(toPublicMachine(machine));
		}

		const cancelMatch = /^\/v1\/machines\/([^/]+)\/cancel$/.exec(path);
		if (method === "POST" && cancelMatch !== null) {
			const principal = yield* requireWorkos(request);
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
			const principal = yield* requireHostedPrincipal(request);
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
			const principal = yield* requireWorkos(request);
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
