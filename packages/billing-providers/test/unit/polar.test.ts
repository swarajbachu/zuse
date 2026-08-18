import { Effect, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import {
	makePolarBillingProvider,
	type PolarBillingClient,
	type PolarCheckout,
	type PolarSubscription,
} from "../../src/polar.ts";

const subscription = (
	status: PolarSubscription["status"] = "active",
): PolarSubscription => ({
	id: "subscription_1",
	status,
	currentPeriodEnd: new Date("2026-08-24T00:00:00.000Z"),
	currentPeriodStart: new Date("2026-07-24T00:00:00.000Z"),
	productId: "product_machine",
	cancelAtPeriodEnd: false,
	customer: { externalId: "account_1" },
});

const checkout = (
	status: PolarCheckout["status"] = "succeeded",
): PolarCheckout => ({
	id: "checkout_abcdef123456",
	status,
	totalAmount: 1_900,
	currency: "usd",
	createdAt: new Date("2026-08-14T10:11:12.000Z"),
	product: { name: "Persistent Standard" },
	externalCustomerId: "account_1",
});

const makeClient = () => {
	const calls = {
		claims: [] as ReadonlyArray<unknown>,
		checkouts: [] as ReadonlyArray<unknown>,
		meterEvents: [] as ReadonlyArray<unknown>,
		meterReads: [] as ReadonlyArray<unknown>,
		revocations: [] as ReadonlyArray<string>,
		sessions: [] as ReadonlyArray<string>,
	};
	let current: PolarSubscription | null = subscription();
	let claimedSubscriptions: ReadonlyArray<string> = [];
	let currentCheckout: PolarCheckout | null = checkout();
	let checkoutFailure: Error | null = null;
	const client: PolarBillingClient = {
		createCheckout: (input) => {
			calls.checkouts = [...calls.checkouts, input];
			return Promise.resolve({ url: "https://sandbox.example/checkout" });
		},
		getCheckout: () =>
			checkoutFailure === null
				? Promise.resolve(currentCheckout)
				: Promise.reject(checkoutFailure),
		getSubscription: () => Promise.resolve(current),
		claimSubscriptions: (input) => {
			calls.claims = [...calls.claims, input];
			return Promise.resolve(claimedSubscriptions);
		},
		revokeSubscription: (subscriptionId) => {
			calls.revocations = [...calls.revocations, subscriptionId];
			return Promise.resolve();
		},
		createCustomerSession: (externalCustomerId) => {
			calls.sessions = [...calls.sessions, externalCustomerId];
			return Promise.resolve({
				customerPortalUrl: "https://sandbox.example/portal",
			});
		},
		ingestMeterEvent: (input) => {
			calls.meterEvents = [...calls.meterEvents, input];
			return Promise.resolve();
		},
		getCustomerMeterUnits: (input) => {
			calls.meterReads = [...calls.meterReads, input];
			return Promise.resolve(125);
		},
	};
	return {
		calls,
		client,
		setCheckout: (value: PolarCheckout | null) => {
			currentCheckout = value;
		},
		setCheckoutFailure: (value: Error | null) => {
			checkoutFailure = value;
		},
		setSubscription: (value: PolarSubscription | null) => {
			current = value;
		},
		setClaimedSubscriptions: (value: ReadonlyArray<string>) => {
			claimedSubscriptions = value;
		},
	};
};

const config = {
	accessToken: Redacted.make("polar_test_token"),
	webhookSecret: Redacted.make("polar_webhook_secret"),
	environment: "sandbox" as const,
	offerProducts: {
		"persistent-standard-v1": "product_machine",
	},
	overageMeterId: "meter_overage",
};

describe("Polar billing provider", () => {
	test("creates checkout and portal sessions using the account identity", async () => {
		const fake = makeClient();
		const provider = makePolarBillingProvider(config, { client: fake.client });

		const result = await Effect.runPromise(
			Effect.all({
				checkout: provider.checkout({
					accountId: "account_1",
					offerId: "persistent-standard-v1",
					successUrl: "https://relay.test/v1/billing/checkout/complete",
					fulfillmentMetadata: {
						sandbox_provider_id: "provider-a",
					},
				}),
				portal: provider.customerPortal("account_1"),
			}),
		);

		expect(result).toEqual({
			checkout: "https://sandbox.example/checkout",
			portal: "https://sandbox.example/portal",
		});
		expect(fake.calls.checkouts).toEqual([
			{
				products: ["product_machine"],
				externalCustomerId: "account_1",
				successUrl: "https://relay.test/v1/billing/checkout/complete",
				metadata: {
					sandbox_provider_id: "provider-a",
					account_id: "account_1",
					offer_id: "persistent-standard-v1",
				},
				allowTrial: false,
			},
		]);
		expect(fake.calls.sessions).toEqual(["account_1"]);
	});

	test("reports idempotent overage-cent meter events", async () => {
		const fake = makeClient();
		const provider = makePolarBillingProvider(config, { client: fake.client });
		await Effect.runPromise(
			provider.reportMeterEvent?.({
				accountId: "account_1",
				eventName: "zuse_cloud_overage_cent",
				units: 125,
				idempotencyKey: "period_1:1",
				metadata: { billing_period_id: "period_1" },
			}) ?? Effect.void,
		);
		expect(fake.calls.meterEvents).toEqual([
			{
				externalCustomerId: "account_1",
				eventName: "zuse_cloud_overage_cent",
				units: 125,
				idempotencyKey: "period_1:1",
				metadata: {
					billing_period_id: "period_1",
					idempotency_key: "period_1:1",
				},
			},
		]);
	});

	test("reads Polar's authoritative customer meter", async () => {
		const fake = makeClient();
		const provider = makePolarBillingProvider(config, { client: fake.client });
		await expect(
			Effect.runPromise(
				provider.reconcileMeter?.({
					accountId: "account_1",
					meterId: "meter_overage",
				}) ?? Effect.succeed(-1),
			),
		).resolves.toBe(125);
		expect(fake.calls.meterReads).toEqual([
			{
				externalCustomerId: "account_1",
				meterId: "meter_overage",
			},
		]);
	});

	test("verifies subscription webhooks and reconciles authoritative state", async () => {
		const fake = makeClient();
		const provider = makePolarBillingProvider(config, {
			client: fake.client,
			verifyWebhook: (_body, _headers, secret) => {
				expect(secret).toBe("polar_webhook_secret");
				return { subscriptionId: "subscription_1" };
			},
		});

		const event = await Effect.runPromise(
			provider.verifyEvent(
				new Request("https://relay.test/v1/billing/webhook/polar", {
					method: "POST",
					headers: { "webhook-id": "event_1" },
					body: "{}",
				}),
			),
		);
		const reconciled = await Effect.runPromise(
			provider.reconcileSubscription(event.subscriptionId),
		);

		expect(event).toEqual({
			eventId: "event_1",
			subscriptionId: "subscription_1",
		});
		expect(reconciled).toEqual({
			accountId: "account_1",
			providerSubscriptionId: "subscription_1",
			status: "active",
			offerId: "persistent-standard-v1",
			periodStart: Date.parse("2026-07-24T00:00:00.000Z"),
			paidThrough: Date.parse("2026-08-24T00:00:00.000Z"),
		});
	});

	test("claims checkout-link subscriptions with a verified account email", async () => {
		const fake = makeClient();
		fake.setClaimedSubscriptions(["subscription_1"]);
		const provider = makePolarBillingProvider(config, { client: fake.client });

		await expect(
			Effect.runPromise(
				provider.claimSubscriptions?.({
					accountId: "account_1",
					verifiedEmail: "buyer@example.com",
				}) ?? Effect.succeed([]),
			),
		).resolves.toEqual(["subscription_1"]);
		expect(fake.calls.claims).toEqual([
			{
				accountId: "account_1",
				email: "buyer@example.com",
				productIds: ["product_machine"],
			},
		]);
	});

	test("reconciles from provider checkout metadata when customer identity is absent", async () => {
		const fake = makeClient();
		fake.setSubscription({
			...subscription("canceled"),
			metadata: {
				account_id: "account_1",
				offer_id: "persistent-standard-v1",
				sandbox_provider_id: "provider-a",
			},
			customer: { externalId: null },
		});
		const provider = makePolarBillingProvider(config, { client: fake.client });

		await expect(
			Effect.runPromise(provider.reconcileSubscription("subscription_1")),
		).resolves.toMatchObject({
			accountId: "account_1",
			offerId: "persistent-standard-v1",
			status: "ended",
			fulfillmentMetadata: { sandbox_provider_id: "provider-a" },
		});
	});

	test("maps grace and ended states and revokes active subscriptions once", async () => {
		const fake = makeClient();
		const provider = makePolarBillingProvider(config, { client: fake.client });

		fake.setSubscription(subscription("past_due"));
		expect(
			(
				await Effect.runPromise(
					provider.reconcileSubscription("subscription_1"),
				)
			).status,
		).toBe("grace");

		await Effect.runPromise(provider.cancel("subscription_1"));
		expect(fake.calls.revocations).toEqual(["subscription_1"]);

		fake.setSubscription({
			...subscription("active"),
			cancelAtPeriodEnd: true,
		});
		await Effect.runPromise(provider.cancel("subscription_1"));
		expect(fake.calls.revocations).toEqual([
			"subscription_1",
			"subscription_1",
		]);

		fake.setSubscription(subscription("canceled"));
		await Effect.runPromise(provider.cancel("subscription_1"));
		expect(fake.calls.revocations).toEqual([
			"subscription_1",
			"subscription_1",
		]);
		expect(
			(
				await Effect.runPromise(
					provider.reconcileSubscription("subscription_1"),
				)
			).status,
		).toBe("ended");
	});

	test("rejects unsigned events and unknown products", async () => {
		const fake = makeClient();
		const provider = makePolarBillingProvider(config, { client: fake.client });
		fake.setSubscription({
			...subscription(),
			productId: "unknown_product",
		});

		const eventError = await Effect.runPromise(
			provider
				.verifyEvent(
					new Request("https://relay.test/v1/billing/webhook/polar", {
						method: "POST",
						headers: {
							"webhook-id": "event_bad",
							"webhook-signature": "v1,bad",
							"webhook-timestamp": "0",
						},
						body: "{}",
					}),
				)
				.pipe(Effect.flip),
		);
		const subscriptionError = await Effect.runPromise(
			provider.reconcileSubscription("subscription_1").pipe(Effect.flip),
		);

		expect(eventError.code).toBe("invalid-event");
		expect(subscriptionError.code).toBe("provider-unavailable");
	});

	test("summarizes a checkout session for the post-purchase page", async () => {
		const fake = makeClient();
		const provider = makePolarBillingProvider(config, { client: fake.client });

		const summary = await Effect.runPromise(
			provider.getCheckout({
				accountId: "account_1",
				checkoutId: "checkout_abcdef123456",
			}),
		);

		expect(summary).toEqual({
			amountCents: 1_900,
			checkoutId: "checkout_abcdef123456",
			createdAtMs: new Date("2026-08-14T10:11:12.000Z").getTime(),
			currency: "usd",
			productName: "Persistent Standard",
			status: "paid",
		});
	});

	test("reports unsettled and unknown checkouts without failing", async () => {
		const fake = makeClient();
		const provider = makePolarBillingProvider(config, { client: fake.client });

		const lookup = { accountId: "account_1", checkoutId: "checkout_1" };
		fake.setCheckout(checkout("confirmed"));
		const pending = await Effect.runPromise(provider.getCheckout(lookup));
		fake.setCheckout(checkout("expired"));
		const expired = await Effect.runPromise(provider.getCheckout(lookup));
		fake.setCheckout(null);
		const missing = await Effect.runPromise(provider.getCheckout(lookup));

		expect(pending?.status).toBe("pending");
		expect(expired?.status).toBe("failed");
		expect(missing).toBeNull();
	});

	test("refuses to summarize another account's checkout", async () => {
		const fake = makeClient();
		const provider = makePolarBillingProvider(config, { client: fake.client });

		const stolen = await Effect.runPromise(
			provider.getCheckout({
				accountId: "account_2",
				checkoutId: "checkout_abcdef123456",
			}),
		);

		expect(stolen).toBeNull();

		// Older checkouts carry the identity on the customer instead.
		fake.setCheckout({
			...checkout(),
			externalCustomerId: null,
			customer: { externalId: "account_1" },
		});
		await expect(
			Effect.runPromise(
				provider.getCheckout({
					accountId: "account_1",
					checkoutId: "checkout_abcdef123456",
				}),
			),
		).resolves.toMatchObject({ productName: "Persistent Standard" });
	});

	test("surfaces checkout lookup transport failures", async () => {
		const fake = makeClient();
		const provider = makePolarBillingProvider(config, { client: fake.client });
		fake.setCheckoutFailure(new Error("network"));

		const exit = await Effect.runPromiseExit(
			provider.getCheckout({
				accountId: "account_1",
				checkoutId: "checkout_1",
			}),
		);

		expect(exit._tag).toBe("Failure");
	});

	test("rejects ambiguous product mappings at startup", () => {
		expect(() =>
			makePolarBillingProvider(
				{
					...config,
					offerProducts: {
						"persistent-standard-v1": "product_machine",
						"persistent-standard-v2": "product_machine",
					},
				},
				{ client: makeClient().client },
			),
		).toThrow("invalid_polar_offer_products");
	});
});
