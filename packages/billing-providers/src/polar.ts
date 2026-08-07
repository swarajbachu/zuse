import { Polar } from "@polar-sh/sdk";
import { validateEvent } from "@polar-sh/sdk/webhooks";
import { Effect, Predicate, Redacted } from "effect";
import {
	type BillingProviderAdapter,
	BillingProviderError,
	type ReconciledSubscription,
} from "./index.ts";

export interface PolarBillingConfig {
	readonly accessToken: Redacted.Redacted<string>;
	readonly webhookSecret: Redacted.Redacted<string>;
	readonly environment: "sandbox" | "production";
	readonly offerProducts: Readonly<Record<string, string>>;
}

export interface PolarSubscription {
	readonly id: string;
	readonly status:
		| "incomplete"
		| "incomplete_expired"
		| "trialing"
		| "active"
		| "past_due"
		| "canceled"
		| "unpaid"
		| "paused"
		| (string & {});
	readonly currentPeriodEnd: Date;
	readonly productId: string;
	readonly cancelAtPeriodEnd: boolean;
	readonly metadata?: Readonly<Record<string, unknown>>;
	readonly customer: {
		readonly externalId?: string | null;
	};
}

export interface PolarBillingClient {
	readonly createCheckout: (input: {
		readonly products: ReadonlyArray<string>;
		readonly externalCustomerId: string;
		readonly successUrl: string;
		readonly metadata: Readonly<Record<string, string>>;
		readonly allowTrial: false;
	}) => Promise<{ readonly url: string }>;
	readonly getSubscription: (
		subscriptionId: string,
	) => Promise<PolarSubscription | null>;
	readonly revokeSubscription: (subscriptionId: string) => Promise<void>;
	readonly createCustomerSession: (
		externalCustomerId: string,
	) => Promise<{ readonly customerPortalUrl: string }>;
}

export interface PolarBillingDependencies {
	readonly client?: PolarBillingClient;
	readonly verifyWebhook?: (
		body: string,
		headers: Readonly<Record<string, string>>,
		secret: string,
	) => { readonly subscriptionId: string };
}

const isNotFound = (error: unknown): boolean =>
	Predicate.isObject(error) &&
	Predicate.hasProperty(error, "statusCode") &&
	error.statusCode === 404;

const makeSdkClient = (config: PolarBillingConfig): PolarBillingClient => {
	const polar = new Polar({
		accessToken: Redacted.value(config.accessToken),
		server: config.environment,
	});
	return {
		createCheckout: (input) =>
			polar.checkouts.create({
				products: [...input.products],
				externalCustomerId: input.externalCustomerId,
				successUrl: input.successUrl,
				metadata: { ...input.metadata },
				allowTrial: input.allowTrial,
			}),
		getSubscription: async (subscriptionId) => {
			try {
				return await polar.subscriptions.get({ id: subscriptionId });
			} catch (error) {
				if (isNotFound(error)) return null;
				throw error;
			}
		},
		revokeSubscription: async (subscriptionId) => {
			await polar.subscriptions.revoke({ id: subscriptionId });
		},
		createCustomerSession: (externalCustomerId) =>
			polar.customerSessions.create({ externalCustomerId }),
	};
};

const verifySubscriptionWebhook = (
	body: string,
	headers: Readonly<Record<string, string>>,
	secret: string,
): { readonly subscriptionId: string } => {
	const event = validateEvent(body, { ...headers }, secret);
	switch (event.type) {
		case "subscription.active":
		case "subscription.canceled":
		case "subscription.created":
		case "subscription.past_due":
		case "subscription.revoked":
		case "subscription.uncanceled":
		case "subscription.updated":
			return { subscriptionId: event.data.id };
		default:
			throw new Error("unsupported_webhook_event");
	}
};

const normalizeStatus = (
	status: PolarSubscription["status"],
): ReconciledSubscription["status"] => {
	switch (status) {
		case "trialing":
		case "active":
			return "active";
		case "past_due":
			return "grace";
		case "incomplete":
			return "pending";
		default:
			return "ended";
	}
};

const makeOfferProductIndex = (
	offerProducts: PolarBillingConfig["offerProducts"],
): ReadonlyMap<string, string> => {
	const entries = Object.entries(offerProducts);
	const products = new Map<string, string>();
	if (entries.length === 0) {
		throw new Error("invalid_polar_offer_products");
	}
	for (const [offerId, productId] of entries) {
		if (
			offerId.trim().length === 0 ||
			productId.trim().length === 0 ||
			products.has(productId)
		) {
			throw new Error("invalid_polar_offer_products");
		}
		products.set(productId, offerId);
	}
	return products;
};

export const makePolarBillingProvider = (
	config: PolarBillingConfig,
	dependencies: PolarBillingDependencies = {},
): BillingProviderAdapter => {
	const client = dependencies.client ?? makeSdkClient(config);
	const verifyWebhook = dependencies.verifyWebhook ?? verifySubscriptionWebhook;
	const offersByProduct = makeOfferProductIndex(config.offerProducts);
	const providerFailure = () =>
		new BillingProviderError({ code: "provider-unavailable" });

	return {
		providerId: "polar",
		checkout: (input) => {
			const productId = config.offerProducts[input.offerId];
			if (productId === undefined) return providerFailure();
			return Effect.tryPromise({
				try: () =>
					client
						.createCheckout({
							products: [productId],
							externalCustomerId: input.accountId,
							successUrl: input.successUrl,
							metadata: {
								account_id: input.accountId,
								offer_id: input.offerId,
							},
							allowTrial: false,
						})
						.then((checkout) => checkout.url),
				catch: providerFailure,
			});
		},
		verifyEvent: (request) =>
			Effect.gen(function* () {
				const eventId = request.headers.get("webhook-id");
				if (eventId === null || eventId.length === 0) {
					return yield* new BillingProviderError({ code: "invalid-event" });
				}
				const body = yield* Effect.tryPromise({
					try: () => request.text(),
					catch: () => new BillingProviderError({ code: "invalid-event" }),
				});
				const verified = yield* Effect.try({
					try: () => {
						const headers: Record<string, string> = {};
						request.headers.forEach((value, key) => {
							headers[key] = value;
						});
						return verifyWebhook(
							body,
							headers,
							Redacted.value(config.webhookSecret),
						);
					},
					catch: () => new BillingProviderError({ code: "invalid-event" }),
				});
				return {
					eventId,
					subscriptionId: verified.subscriptionId,
				};
			}),
		reconcileSubscription: (subscriptionId) =>
			Effect.gen(function* () {
				const subscription = yield* Effect.tryPromise({
					try: () => client.getSubscription(subscriptionId),
					catch: providerFailure,
				});
				const metadataAccountId = subscription?.metadata?.account_id;
				const metadataOfferId = subscription?.metadata?.offer_id;
				const accountId =
					subscription?.customer.externalId ??
					(typeof metadataAccountId === "string"
						? metadataAccountId
						: undefined);
				const offerId =
					subscription === null
						? undefined
						: offersByProduct.get(subscription.productId);
				if (
					subscription === null ||
					accountId === undefined ||
					accountId === null ||
					offerId === undefined ||
					(typeof metadataOfferId === "string" && metadataOfferId !== offerId)
				) {
					return yield* providerFailure();
				}
				return {
					accountId,
					providerSubscriptionId: subscription.id,
					status: normalizeStatus(subscription.status),
					offerId,
					paidThrough: subscription.currentPeriodEnd.getTime(),
				};
			}),
		cancel: (subscriptionId) =>
			Effect.gen(function* () {
				const subscription = yield* Effect.tryPromise({
					try: () => client.getSubscription(subscriptionId),
					catch: providerFailure,
				});
				if (
					subscription === null ||
					normalizeStatus(subscription.status) === "ended"
				) {
					return;
				}
				yield* Effect.tryPromise({
					try: () => client.revokeSubscription(subscriptionId),
					catch: providerFailure,
				});
			}),
		customerPortal: (accountId) =>
			Effect.tryPromise({
				try: () =>
					client
						.createCustomerSession(accountId)
						.then((session) => session.customerPortalUrl),
				catch: providerFailure,
			}),
	};
};
