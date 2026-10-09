import { Effect, Redacted } from "effect";
import Stripe from "stripe";
import { type BillingProviderAdapter, BillingProviderError } from "./index.ts";

export interface StripeBillingConfig {
	readonly secretKey: Redacted.Redacted<string>;
	readonly webhookSecret: Redacted.Redacted<string>;
	readonly offerPrices: Readonly<Record<string, string>>;
	readonly cloudOveragePriceId?: string;
	readonly portalReturnUrl: string;
	readonly portalConfigurationId?: string;
}

/** Stable identity for one remote creation attempt; generation zero preserves legacy keys. */
export interface StripeCustomerReservation {
	readonly customerId?: string;
	readonly createdAtMs: number;
	readonly generation: number;
}

/** Persisted by the application, including unfinished remote operations. */
export interface StripeBillingStore {
	readonly reserveCustomer: (
		accountId: string,
	) => Promise<StripeCustomerReservation>;
	/** Renews only the expected unlinked generation; concurrent callers receive the winner. */
	readonly renewCustomerReservation: (
		accountId: string,
		generation: number,
	) => Promise<StripeCustomerReservation>;
	readonly linkCustomer: (
		accountId: string,
		customerId: string,
	) => Promise<void>;
	readonly getCustomer: (accountId: string) => Promise<string | null>;
	readonly claimDelivery: (
		key: string,
		payload: string,
	) => Promise<"send" | "sent" | "busy" | "expired">;
	readonly finishDelivery: (key: string, sent: boolean) => Promise<void>;
}

export interface StripeSubscription {
	readonly id: string;
	readonly status: string;
	readonly metadata: Readonly<Record<string, string>>;
	readonly customerAccountId?: string;
	readonly customerId: string;
	readonly items: ReadonlyArray<{
		readonly priceId: string;
		readonly periodStart: number;
		readonly periodEnd: number;
	}>;
}
export interface StripeCheckout {
	readonly id: string;
	readonly accountId: string | null;
	readonly amountCents: number;
	readonly currency: string;
	readonly status: "paid" | "pending" | "failed";
	readonly createdAtMs: number;
}
export interface StripeBillingClient {
	readonly createCustomer: (accountId: string, key: string) => Promise<string>;
	/** Lists exact metadata matches, stopping after two to detect ambiguous bindings. */
	readonly findCustomersByAccount: (
		accountId: string,
	) => Promise<ReadonlyArray<string>>;
	readonly customerAccountId: (
		customerId: string,
	) => Promise<string | undefined>;
	readonly createCheckout: (
		params: Stripe.Checkout.SessionCreateParams,
	) => Promise<string>;
	readonly getCheckout: (id: string) => Promise<StripeCheckout | null>;
	readonly getSubscription: (id: string) => Promise<StripeSubscription | null>;
	readonly cancelSubscription: (id: string) => Promise<void>;
	readonly createPortal: (
		customerId: string,
		returnUrl: string,
	) => Promise<string>;
	readonly canReportOverage: (
		customerId: string,
		subscriptionId: string,
		periodStartMs: number,
		periodEndMs: number,
	) => Promise<boolean>;
	readonly reportMeter: (
		params: Stripe.Billing.MeterEventCreateParams,
		key: string,
	) => Promise<void>;
	readonly meterTotal: (
		customerId: string,
		meterId: string,
		start: number,
		end: number,
	) => Promise<number>;
}
export interface StripeBillingDependencies {
	readonly store: StripeBillingStore;
	readonly client?: StripeBillingClient;
	readonly verifyWebhook?: (
		body: string,
		signature: string,
		secret: string,
	) => Promise<Stripe.Event>;
	readonly now?: () => number;
}

const notFound = (error: unknown) =>
	error instanceof Stripe.errors.StripeInvalidRequestError &&
	error.statusCode === 404;
/** Uses fetch for Worker compatibility and bounds retry time for billing requests. */
const makeSdk = (config: StripeBillingConfig) =>
	new Stripe(Redacted.value(config.secretKey), {
		httpClient: Stripe.createFetchHttpClient(),
		maxNetworkRetries: 1,
		timeout: 10_000,
	});
/** Translates Stripe SDK objects into the billing adapter contract. */
const makeClient = (
	sdk: Stripe,
	config: StripeBillingConfig,
): StripeBillingClient => ({
	createCustomer: async (accountId, key) =>
		(
			await sdk.customers.create(
				{ metadata: { account_id: accountId } },
				{ idempotencyKey: key },
			)
		).id,
	findCustomersByAccount: async (accountId) => {
		const matches: string[] = [];
		// Search is eventually consistent and cannot establish absence before a retry.
		for await (const customer of sdk.customers.list({ limit: 100 })) {
			if (customer.metadata.account_id === accountId) matches.push(customer.id);
			if (matches.length === 2) break;
		}
		return matches;
	},
	customerAccountId: async (id) => {
		const customer = await sdk.customers.retrieve(id);
		return customer.deleted ? undefined : customer.metadata.account_id;
	},
	createCheckout: async (params) => {
		const session = await sdk.checkout.sessions.create(params);
		if (!session.url) throw new Error("checkout_url_missing");
		return session.url;
	},
	getCheckout: async (id) => {
		try {
			const session = await sdk.checkout.sessions.retrieve(id);
			return {
				id: session.id,
				accountId: session.client_reference_id,
				amountCents: session.amount_total ?? 0,
				currency: session.currency ?? "usd",
				status:
					session.payment_status === "paid" ||
					session.payment_status === "no_payment_required"
						? "paid"
						: session.status === "expired"
							? "failed"
							: "pending",
				createdAtMs: session.created * 1_000,
			};
		} catch (error) {
			if (notFound(error)) return null;
			throw error;
		}
	},
	getSubscription: async (id) => {
		try {
			const subscription = await sdk.subscriptions.retrieve(id, {
				expand: ["customer"],
			});
			const customer = subscription.customer;
			return {
				id: subscription.id,
				status: subscription.status,
				metadata: subscription.metadata,
				customerId: typeof customer === "string" ? customer : customer.id,
				customerAccountId:
					typeof customer === "string" || customer.deleted
						? undefined
						: customer.metadata.account_id,
				items: subscription.items.data.map((item) => ({
					priceId: item.price.id,
					periodStart: item.current_period_start,
					periodEnd: item.current_period_end,
				})),
			};
		} catch (error) {
			if (notFound(error)) return null;
			throw error;
		}
	},
	cancelSubscription: async (id) => {
		await sdk.subscriptions.cancel(id, {}, { idempotencyKey: `cancel:${id}` });
	},
	createPortal: async (customer, return_url) =>
		(
			await sdk.billingPortal.sessions.create({
				customer,
				return_url,
				...(config.portalConfigurationId
					? { configuration: config.portalConfigurationId }
					: {}),
			})
		).url,
	canReportOverage: async (
		customerId,
		subscriptionId,
		periodStartMs,
		periodEndMs,
	) => {
		const subscription = await sdk.subscriptions.retrieve(subscriptionId);
		if (
			(typeof subscription.customer === "string"
				? subscription.customer
				: subscription.customer.id) !== customerId
		)
			return false;
		if (
			!["canceled", "incomplete_expired"].includes(subscription.status) &&
			subscription.items.data.some(
				(item) =>
					item.price.id === config.cloudOveragePriceId &&
					item.current_period_start * 1000 === periodStartMs &&
					item.current_period_end * 1000 === periodEndMs,
			)
		)
			return true;
		// Late usage is safe only while its original metered invoice is draft.
		// A successful meter request cannot amend an already finalized invoice.
		for await (const invoice of sdk.invoices.list({
			subscription: subscriptionId,
			created: { gte: Math.floor(periodEndMs / 1000) - 300 },
			limit: 10,
		})) {
			for await (const line of sdk.invoices.listLineItems(invoice.id, {
				limit: 100,
			})) {
				if (
					line.pricing?.price_details?.price === config.cloudOveragePriceId &&
					line.period.start * 1000 === periodStartMs &&
					line.period.end * 1000 === periodEndMs
				)
					return invoice.status === "draft";
			}
		}
		return false;
	},
	reportMeter: async (params, key) => {
		await sdk.billing.meterEvents.create(params, { idempotencyKey: key });
	},
	meterTotal: async (customer, meter, start_time, end_time) => {
		let total = 0;
		for await (const summary of sdk.billing.meters.listEventSummaries(meter, {
			customer,
			start_time,
			end_time,
			limit: 100,
		}))
			total += summary.aggregated_value;
		return total;
	},
});

const failure = () =>
	new BillingProviderError({ code: "provider-unavailable" });
const needsReconciliation = () =>
	new BillingProviderError({ code: "reconciliation-required" });
const status = (value: string) =>
	value === "active" || value === "trialing"
		? "active"
		: value === "past_due"
			? "grace"
			: value === "incomplete"
				? "pending"
				: "ended";

/** Stripe checkout, subscription and usage operations with durable application receipts. */
export const makeStripeBillingProvider = (
	config: StripeBillingConfig,
	deps: StripeBillingDependencies,
): BillingProviderAdapter => {
	const prices = new Map<string, string>();
	for (const [offer, price] of Object.entries(config.offerPrices)) {
		if (
			!offer.trim() ||
			!price.trim() ||
			prices.has(price) ||
			price === config.cloudOveragePriceId
		)
			throw new Error("invalid_stripe_offer_prices");
		prices.set(price, offer);
	}
	if (prices.size === 0) throw new Error("invalid_stripe_offer_prices");
	const sdk = makeSdk(config);
	const client = deps.client ?? makeClient(sdk, config);
	const verify =
		deps.verifyWebhook ??
		((body, signature, secret) =>
			sdk.webhooks.constructEventAsync(
				body,
				signature,
				secret,
				undefined,
				Stripe.createSubtleCryptoProvider(),
			));
	const now = deps.now ?? Date.now;
	const call = <A>(run: () => Promise<A>) =>
		Effect.tryPromise({ try: run, catch: failure });
	/** Rejects a persisted binding whose remote ownership no longer matches. */
	const verifiedCustomer = (accountId: string, customerId: string) =>
		Effect.gen(function* () {
			if (
				(yield* call(() => client.customerAccountId(customerId))) !== accountId
			)
				return yield* failure();
			return customerId;
		});
	const customer = (accountId: string, create: boolean) =>
		Effect.gen(function* () {
			const existing = yield* call(() => deps.store.getCustomer(accountId));
			if (existing !== null)
				return yield* verifiedCustomer(accountId, existing);
			if (!create) return yield* failure();
			let reservation = yield* call(() =>
				deps.store.reserveCustomer(accountId),
			);
			if (
				reservation.customerId === undefined &&
				now() - reservation.createdAtMs >= 23 * 60 * 60_000
			) {
				const matches = yield* call(() =>
					client.findCustomersByAccount(accountId),
				);
				if (matches.length > 1) return yield* needsReconciliation();
				const recovered = matches[0];
				if (recovered !== undefined) {
					yield* call(() => deps.store.linkCustomer(accountId, recovered));
					return recovered;
				}
				const generation = reservation.generation;
				reservation = yield* call(() =>
					deps.store.renewCustomerReservation(accountId, generation),
				);
			}
			if (reservation.customerId !== undefined)
				return yield* verifiedCustomer(accountId, reservation.customerId);
			// A losing renewal must use the winner's key, never replay an expired generation.
			if (now() - reservation.createdAtMs >= 23 * 60 * 60_000)
				return yield* needsReconciliation();
			const key =
				reservation.generation === 0
					? `zuse-customer:${accountId}`
					: `zuse-customer:${accountId}:generation:${reservation.generation}`;
			const id = yield* call(() => client.createCustomer(accountId, key));
			yield* call(() => deps.store.linkCustomer(accountId, id));
			return id;
		});
	return {
		providerId: "stripe",
		checkout: (input) =>
			Effect.gen(function* () {
				const price = config.offerPrices[input.offerId];
				if (price === undefined) return yield* failure();
				const customerId = yield* customer(input.accountId, true);
				const metadata = {
					...input.fulfillmentMetadata,
					account_id: input.accountId,
					offer_id: input.offerId,
				};
				return yield* call(() =>
					client.createCheckout({
						mode: "subscription",
						customer: customerId,
						client_reference_id: input.accountId,
						success_url: input.successUrl.replaceAll(
							"{CHECKOUT_ID}",
							"{CHECKOUT_SESSION_ID}",
						),
						line_items: [
							{ price, quantity: 1 },
							...(input.offerId === "cloud-workspace-standard-v1" &&
							config.cloudOveragePriceId
								? [{ price: config.cloudOveragePriceId }]
								: []),
						],
						metadata,
						subscription_data: { metadata },
						automatic_tax: { enabled: true },
						billing_address_collection: "required",
						tax_id_collection: { enabled: true },
						customer_update: { address: "auto", name: "auto" },
					}),
				);
			}),
		getCheckout: (input) =>
			call(() => client.getCheckout(input.checkoutId)).pipe(
				Effect.map((session) =>
					session === null || session.accountId !== input.accountId
						? null
						: {
								checkoutId: session.id,
								amountCents: session.amountCents,
								currency: session.currency,
								createdAtMs: session.createdAtMs,
								status: session.status,
							},
				),
			),
		verifyEvent: (request) =>
			Effect.gen(function* () {
				const invalid = () =>
					new BillingProviderError({ code: "invalid-event" });
				const signature = request.headers.get("stripe-signature");
				if (!signature) return yield* invalid();
				const body = yield* Effect.tryPromise({
					try: () => request.text(),
					catch: invalid,
				});
				const event = yield* Effect.tryPromise({
					try: () =>
						verify(body, signature, Redacted.value(config.webhookSecret)),
					catch: invalid,
				});
				switch (event.type) {
					case "customer.subscription.created":
					case "customer.subscription.updated":
					case "customer.subscription.deleted":
					case "customer.subscription.paused":
					case "customer.subscription.resumed":
						return { eventId: event.id, subscriptionId: event.data.object.id };
					case "invoice.paid":
					case "invoice.payment_failed": {
						const subscription =
							event.data.object.parent?.subscription_details?.subscription;
						return subscription
							? {
									eventId: event.id,
									subscriptionId:
										typeof subscription === "string"
											? subscription
											: subscription.id,
								}
							: null;
					}
					default:
						return null;
				}
			}),
		reconcileSubscription: (id) =>
			Effect.gen(function* () {
				const sub = yield* call(() => client.getSubscription(id));
				if (sub === null) return yield* failure();
				const baseItems = sub.items.filter((item) => prices.has(item.priceId));
				if (baseItems.length !== 1) return yield* failure();
				const base = baseItems[0];
				if (base === undefined) return yield* failure();
				const offerId = prices.get(base.priceId);
				if (offerId === undefined) return yield* failure();
				const accountId = sub.customerAccountId;
				if (!accountId?.trim())
					return yield* new BillingProviderError({
						code: "subscription-unlinked",
					});
				if (
					(sub.metadata.account_id && sub.metadata.account_id !== accountId) ||
					(sub.metadata.offer_id && sub.metadata.offer_id !== offerId)
				)
					return yield* failure();
				const linkedCustomer = yield* call(() =>
					deps.store.getCustomer(accountId),
				);
				if (linkedCustomer !== null && linkedCustomer !== sub.customerId)
					return yield* failure();
				if (linkedCustomer === null)
					return yield* new BillingProviderError({
						code: "subscription-unlinked",
					});
				const fulfillmentMetadata = Object.fromEntries(
					Object.entries(sub.metadata).filter(
						([key]) => key !== "account_id" && key !== "offer_id",
					),
				);
				return {
					accountId,
					providerSubscriptionId: sub.id,
					offerId,
					status: status(sub.status),
					periodStart: base.periodStart * 1_000,
					paidThrough: base.periodEnd * 1_000,
					...(Object.keys(fulfillmentMetadata).length
						? { fulfillmentMetadata }
						: {}),
				};
			}),
		cancel: (id) =>
			Effect.gen(function* () {
				const sub = yield* call(() => client.getSubscription(id));
				if (
					sub === null ||
					sub.status === "canceled" ||
					sub.status === "incomplete_expired"
				)
					return;
				yield* call(() => client.cancelSubscription(id));
			}),
		customerPortal: (accountId) =>
			customer(accountId, false).pipe(
				Effect.flatMap((id) =>
					call(() => client.createPortal(id, config.portalReturnUrl)),
				),
			),
		reportMeterEvent: (input) =>
			Effect.gen(function* () {
				if (!Number.isSafeInteger(input.units)) return yield* failure();
				if (input.units === 0) return;
				const timestamp =
					input.occurredAtMs === undefined
						? undefined
						: Math.floor(input.occurredAtMs / 1_000);
				if (
					timestamp === undefined ||
					!Number.isSafeInteger(timestamp) ||
					timestamp * 1_000 < now() - 35 * 24 * 60 * 60_000 ||
					timestamp * 1_000 > now() + 5 * 60_000
				)
					return yield* needsReconciliation();
				const customerId = yield* customer(input.accountId, false);
				// Meter identifiers have a 100-character limit. Hash long ledger keys.
				const bytes = new TextEncoder().encode(input.idempotencyKey);
				const digest = yield* call(() =>
					crypto.subtle.digest("SHA-256", bytes),
				);
				const identifier = `zuse_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
				const params = {
					event_name: input.eventName,
					identifier,
					timestamp,
					payload: {
						stripe_customer_id: customerId,
						value: String(input.units),
					},
				};
				const claim = yield* call(() =>
					deps.store.claimDelivery(identifier, JSON.stringify(params)),
				);
				if (claim === "sent") return;
				if (claim === "expired") return yield* needsReconciliation();
				if (claim === "busy") return yield* failure();
				if (input.eventName === "zuse_cloud_overage_cent") {
					const subscriptionId = input.metadata?.provider_subscription_id;
					const periodStartMs = Number(input.metadata?.period_start_ms);
					const periodEndMs = Number(input.metadata?.period_end_ms);
					if (
						!subscriptionId ||
						!Number.isSafeInteger(periodStartMs) ||
						!Number.isSafeInteger(periodEndMs) ||
						periodEndMs <= periodStartMs ||
						!(yield* call(() =>
							client.canReportOverage(
								customerId,
								subscriptionId,
								periodStartMs,
								periodEndMs,
							),
						))
					) {
						yield* call(() => deps.store.finishDelivery(identifier, false));
						return yield* needsReconciliation();
					}
				}

				const result = yield* call(() =>
					client.reportMeter(params, identifier),
				).pipe(Effect.result);
				yield* call(() =>
					deps.store.finishDelivery(identifier, result._tag === "Success"),
				);
				if (result._tag === "Failure") return yield* result.failure;
			}),
		reconcileMeter: (input) =>
			Effect.gen(function* () {
				const { periodStartMs, periodEndMs } = input;
				if (
					periodStartMs === undefined ||
					periodEndMs === undefined ||
					periodEndMs <= periodStartMs
				)
					return yield* failure();
				// The invoice outbox places first-minute usage at the next full
				// minute. Adjacent periods therefore have disjoint summary windows.
				const start = Math.ceil(periodStartMs / 60_000) * 60;
				const end = Math.ceil(periodEndMs / 60_000) * 60;
				if (start >= end) return yield* needsReconciliation();
				const id = yield* customer(input.accountId, false);
				return yield* call(() =>
					client.meterTotal(id, input.meterId, start, end),
				);
			}),
	};
};
