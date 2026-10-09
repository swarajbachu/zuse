import { Effect, Redacted } from "effect";
import Stripe from "stripe";
import { describe, expect, test, vi } from "vitest";
import {
	makeStripeBillingProvider,
	type StripeBillingClient,
	type StripeBillingStore,
	type StripeSubscription,
} from "../../src/stripe.ts";

const now = 1_790_000_000_000;
const config = {
	secretKey: Redacted.make("sk_test_example"),
	webhookSecret: Redacted.make("whsec_example"),
	offerPrices: { "cloud-workspace-standard-v1": "price_base" },
	cloudOveragePriceId: "price_overage",
	portalReturnUrl: "https://api.test",
};
const subscription = (): StripeSubscription => ({
	id: "sub_1",
	status: "active",
	customerId: "cus_1",
	customerAccountId: "account",
	metadata: {
		account_id: "account",
		offer_id: "cloud-workspace-standard-v1",
		provider: "boxd",
	},
	items: [
		{
			priceId: "price_base",
			periodStart: 1_789_000_020,
			periodEnd: 1_791_000_000,
		},
		{
			priceId: "price_overage",
			periodStart: 1_789_000_020,
			periodEnd: 1_791_000_000,
		},
	],
});
const setup = () => {
	let sub: StripeSubscription | null = subscription();
	let linked: string | null = "cus_1";
	let reservedAt = now;
	let generation = 0;
	let recoveryCursor: string | undefined;
	let recoveryMatches: ReadonlyArray<string> = [];
	let recoveryComplete = false;
	let claim: "send" | "sent" | "busy" | "expired" = "send";
	const store: StripeBillingStore = {
		claimCustomerRecoveries: async () =>
			linked === null &&
			now - reservedAt >= 23 * 60 * 60_000 &&
			!recoveryComplete
				? [
						{
							accountId: "account",
							createdAtMs: reservedAt,
							generation,
							recoveryCursor,
							recoveryMatches,
							recoveryComplete,
						},
					]
				: [],
		finishCustomerRecovery: async (
			_account,
			expectedGeneration,
			cursor,
			page,
		) => {
			if (
				generation !== expectedGeneration ||
				cursor !== recoveryCursor ||
				recoveryComplete
			)
				return;
			recoveryMatches = [
				...new Set([...recoveryMatches, ...page.matches]),
			].slice(0, 2);
			recoveryCursor = page.nextCursor;
			recoveryComplete =
				page.nextCursor === undefined || recoveryMatches.length > 1;
		},
		getCustomer: async () => linked,
		reserveCustomer: async () => ({
			customerId: linked ?? undefined,
			createdAtMs: reservedAt,
			generation,
			recoveryCursor,
			recoveryMatches,
			recoveryComplete,
		}),
		renewCustomerReservation: vi.fn(async (_account, expectedGeneration) => {
			if (linked === null && expectedGeneration === generation) {
				reservedAt = now;
				generation++;
				recoveryCursor = undefined;
				recoveryMatches = [];
				recoveryComplete = false;
			}
			return {
				customerId: linked ?? undefined,
				createdAtMs: reservedAt,
				generation,
				recoveryCursor,
				recoveryMatches,
				recoveryComplete,
			};
		}),
		linkCustomer: async (_account, id) => {
			linked = id;
		},
		claimDelivery: async () => claim,
		finishDelivery: vi.fn(async (_key, sent) => {
			if (sent) claim = "sent";
		}),
	};
	const client: StripeBillingClient = {
		customerPage: vi.fn(async () => ({ matches: [] })),
		createCustomer: vi.fn(async () => "cus_1"),
		customerAccountId: async () => "account",
		createCheckout: vi.fn(async () => "https://checkout.stripe.test"),
		getCheckout: async () => ({
			id: "cs_1",
			accountId: "account",
			amountCents: 4000,
			currency: "usd",
			status: "paid",
			createdAtMs: now,
		}),
		getSubscription: async () => sub,
		cancelSubscription: vi.fn(async () => {}),
		createPortal: vi.fn(async () => "https://portal.stripe.test"),
		canReportOverage: vi.fn(async () => true),
		reportMeter: vi.fn(async () => {}),
		meterTotal: vi.fn(async () => 125),
	};
	const provider = makeStripeBillingProvider(config, {
		client,
		store,
		now: () => now,
	});
	if (
		!provider.reportMeterEvent ||
		!provider.reconcileMeter ||
		!provider.recoverCustomers
	)
		throw new Error("Missing metering methods");
	return {
		provider: {
			...provider,
			reportMeterEvent: provider.reportMeterEvent,
			reconcileMeter: provider.reconcileMeter,
			recoverCustomers: provider.recoverCustomers,
		},
		client,
		store,
		setSub: (value: StripeSubscription | null) => {
			sub = value;
		},
		setLinked: (value: string | null) => {
			linked = value;
		},
		setReservedAt: (value: number) => {
			reservedAt = value;
		},
		setClaim: (value: typeof claim) => {
			claim = value;
		},
	};
};
const meter = {
	accountId: "account",
	eventName: "zuse_cloud_overage_cent",
	units: 125,
	idempotencyKey: "ledger:key".repeat(20),
	occurredAtMs: now - 1_000,
	metadata: {
		provider_subscription_id: "sub_1",
		period_start_ms: "1789000020000",
		period_end_ms: "1791000000000",
	},
};

describe("Stripe billing provider", () => {
	test("checkout includes base and overage prices, tax, ownership and receipt placeholder", async () => {
		const { provider, client } = setup();
		await Effect.runPromise(
			provider.checkout({
				accountId: "account",
				offerId: "cloud-workspace-standard-v1",
				successUrl: "https://api.test/complete?id={CHECKOUT_ID}",
				fulfillmentMetadata: { account_id: "forged", offer_id: "forged" },
			}),
		);
		expect(client.createCheckout).toHaveBeenCalledWith(
			expect.objectContaining({
				customer: "cus_1",
				client_reference_id: "account",
				success_url: "https://api.test/complete?id={CHECKOUT_SESSION_ID}",
				automatic_tax: { enabled: true },
				billing_address_collection: "required",
				line_items: [
					{ price: "price_base", quantity: 1 },
					{ price: "price_overage" },
				],
				subscription_data: {
					metadata: {
						account_id: "account",
						offer_id: "cloud-workspace-standard-v1",
					},
				},
			}),
		);
	});
	test("creates and persists a customer using a stable idempotency key", async () => {
		const fake = setup();
		fake.setLinked(null);
		await Effect.runPromise(
			fake.provider.checkout({
				accountId: "account",
				offerId: "cloud-workspace-standard-v1",
				successUrl: "https://api.test",
			}),
		);
		expect(fake.client.createCustomer).toHaveBeenCalledWith(
			"account",
			"zuse-customer:account",
		);
		expect(await fake.store.getCustomer("account")).toBe("cus_1");
	});
	test("does not recreate a customer when expired recovery finds multiple matches", async () => {
		const fake = setup();
		fake.setLinked(null);
		fake.setReservedAt(now - 24 * 60 * 60_000);
		vi.spyOn(fake.client, "customerPage").mockResolvedValue({
			matches: ["cus_1", "cus_2"],
		});
		await Effect.runPromise(fake.provider.recoverCustomers());
		await expect(
			Effect.runPromise(
				fake.provider.checkout({
					accountId: "account",
					offerId: "cloud-workspace-standard-v1",
					successUrl: "https://api.test",
				}),
			),
		).rejects.toMatchObject({ code: "reconciliation-required" });
		expect(fake.client.createCustomer).not.toHaveBeenCalled();
	});

	test.each([
		{ matches: [] },
		{ matches: ["cus_recovered"] },
	])("recovers expired customer reservation with matches %j", async ({
		matches,
	}) => {
		const fake = setup();
		fake.setLinked(null);
		fake.setReservedAt(now - 24 * 60 * 60_000);
		vi.spyOn(fake.client, "customerPage").mockResolvedValue({ matches });
		await Effect.runPromise(fake.provider.recoverCustomers());
		const checkout = () =>
			Effect.runPromise(
				fake.provider.checkout({
					accountId: "account",
					offerId: "cloud-workspace-standard-v1",
					successUrl: "https://api.test",
				}),
			);
		await Promise.all(Array.from({ length: 8 }, checkout));
		if (matches.length) {
			expect(fake.client.createCustomer).not.toHaveBeenCalled();
			expect(fake.store.renewCustomerReservation).not.toHaveBeenCalled();
			expect(await fake.store.getCustomer("account")).toBe("cus_recovered");
		} else {
			expect(fake.client.createCustomer).toHaveBeenCalled();
			for (const call of vi.mocked(fake.client.createCustomer).mock.calls)
				expect(call).toEqual(["account", "zuse-customer:account:generation:1"]);
		}
	});
	test("recovery lookup failure cannot renew or create a customer", async () => {
		const fake = setup();
		fake.setLinked(null);
		fake.setReservedAt(now - 24 * 60 * 60_000);
		vi.spyOn(fake.client, "customerPage").mockRejectedValue(
			new Error("unavailable"),
		);
		expect(await Effect.runPromise(fake.provider.recoverCustomers())).toBe(0);
		await expect(
			Effect.runPromise(
				fake.provider.checkout({
					accountId: "account",
					offerId: "cloud-workspace-standard-v1",
					successUrl: "https://api.test",
				}),
			),
		).rejects.toMatchObject({ code: "reconciliation-required" });
		expect(fake.store.renewCustomerReservation).not.toHaveBeenCalled();
		expect(fake.client.createCustomer).not.toHaveBeenCalled();
	});
	test("a binding established during renewal avoids another remote creation", async () => {
		const fake = setup();
		fake.setLinked(null);
		fake.setReservedAt(now - 24 * 60 * 60_000);
		await Effect.runPromise(fake.provider.recoverCustomers());
		vi.spyOn(fake.store, "renewCustomerReservation").mockResolvedValue({
			customerId: "cus_1",
			createdAtMs: now,
			generation: 1,
			recoveryComplete: false,
			recoveryMatches: [],
		});
		await Effect.runPromise(
			fake.provider.checkout({
				accountId: "account",
				offerId: "cloud-workspace-standard-v1",
				successUrl: "https://api.test",
			}),
		);
		expect(fake.client.createCustomer).not.toHaveBeenCalled();
	});
	test("checkout lookup does not disclose another account's purchase", async () => {
		const { provider } = setup();
		expect(
			await Effect.runPromise(
				provider.getCheckout({ accountId: "other", checkoutId: "cs_1" }),
			),
		).toBeNull();
		expect(
			await Effect.runPromise(
				provider.getCheckout({ accountId: "account", checkoutId: "cs_1" }),
			),
		).toMatchObject({ amountCents: 4000, status: "paid" });
	});
	test.each([
		["active", "active"],
		["trialing", "active"],
		["past_due", "grace"],
		["incomplete", "pending"],
		["canceled", "ended"],
		["unpaid", "ended"],
		["paused", "ended"],
	])("normalizes %s subscription status", async (remote, expected) => {
		const fake = setup();
		fake.setSub({ ...subscription(), status: remote });
		expect(
			await Effect.runPromise(fake.provider.reconcileSubscription("sub_1")),
		).toMatchObject({
			status: expected,
			accountId: "account",
			periodStart: 1_789_000_020_000,
			fulfillmentMetadata: { provider: "boxd" },
		});
	});
	test("rejects conflicting account metadata and customer bindings", async () => {
		const fake = setup();
		fake.setSub({ ...subscription(), metadata: { account_id: "other" } });
		await expect(
			Effect.runPromise(fake.provider.reconcileSubscription("sub_1")),
		).rejects.toMatchObject({ code: "provider-unavailable" });
		fake.setSub(subscription());
		fake.setLinked("cus_other");
		await expect(
			Effect.runPromise(fake.provider.reconcileSubscription("sub_1")),
		).rejects.toMatchObject({ code: "provider-unavailable" });
	});
	test("requires exactly one configured base price", async () => {
		const fake = setup();
		fake.setSub({ ...subscription(), items: [] });
		await expect(
			Effect.runPromise(fake.provider.reconcileSubscription("sub_1")),
		).rejects.toMatchObject({ code: "provider-unavailable" });
	});
	test("cancellation is idempotent for ended or missing subscriptions", async () => {
		const fake = setup();
		fake.setSub({ ...subscription(), status: "canceled" });
		await Effect.runPromise(fake.provider.cancel("sub_1"));
		fake.setSub(null);
		await Effect.runPromise(fake.provider.cancel("missing"));
		expect(fake.client.cancelSubscription).not.toHaveBeenCalled();
	});
	test("reports cents with original seconds timestamp and bounded stable identifier", async () => {
		const { provider, client } = setup();
		await Effect.runPromise(provider.reportMeterEvent(meter));
		await Effect.runPromise(provider.reportMeterEvent(meter));
		expect(client.reportMeter).toHaveBeenCalledTimes(1);
		expect(client.reportMeter).toHaveBeenCalledWith(
			expect.objectContaining({
				event_name: meter.eventName,
				timestamp: Math.floor(meter.occurredAtMs / 1_000),
				identifier: expect.stringMatching(/^zuse_[a-f0-9]{64}$/),
				payload: { stripe_customer_id: "cus_1", value: "125" },
			}),
			expect.stringMatching(/^zuse_/),
		);
	});
	test.each([
		"busy",
		"expired",
	] as const)("does not resend %s delivery", async (claim) => {
		const fake = setup();
		fake.setClaim(claim);
		await expect(
			Effect.runPromise(fake.provider.reportMeterEvent(meter)),
		).rejects.toMatchObject({
			code:
				claim === "expired"
					? "reconciliation-required"
					: "provider-unavailable",
		});
		expect(fake.client.reportMeter).not.toHaveBeenCalled();
	});
	test("does not rewrite stale timestamps to make usage billable", async () => {
		const fake = setup();
		await expect(
			Effect.runPromise(
				fake.provider.reportMeterEvent({
					...meter,
					occurredAtMs: now - 36 * 24 * 60 * 60_000,
				}),
			),
		).rejects.toMatchObject({ code: "reconciliation-required" });
		expect(fake.client.reportMeter).not.toHaveBeenCalled();
	});
	test("reconciliation uses explicit billing-period boundaries", async () => {
		const { provider, client } = setup();
		expect(
			await Effect.runPromise(
				provider.reconcileMeter({
					accountId: "account",
					meterId: "meter",
					periodStartMs: 1_789_000_020_000,
					periodEndMs: 1_791_000_000_000,
				}),
			),
		).toBe(125);
		expect(client.meterTotal).toHaveBeenCalledWith(
			"cus_1",
			"meter",
			1_789_000_020,
			1_791_000_000,
		);
	});
	test("validates raw-body webhook signatures and ignores unrelated valid events", async () => {
		const { provider } = setup();
		const sdk = new Stripe("sk_test_example");
		const body = JSON.stringify({
			id: "evt_1",
			type: "customer.subscription.updated",
			data: { object: { id: "sub_1" } },
		});
		const signature = sdk.webhooks.generateTestHeaderString({
			payload: body,
			secret: "whsec_example",
		});
		const request = () =>
			new Request("https://api.test/v1/billing/webhook/stripe", {
				method: "POST",
				headers: { "stripe-signature": signature },
				body,
			});
		expect(await Effect.runPromise(provider.verifyEvent(request()))).toEqual({
			eventId: "evt_1",
			subscriptionId: "sub_1",
		});
		await expect(
			Effect.runPromise(
				provider.verifyEvent(new Request(request(), { body: `${body} ` })),
			),
		).rejects.toMatchObject({ code: "invalid-event" });
		const ignoredBody = JSON.stringify({
			id: "evt_2",
			type: "customer.created",
			data: { object: { id: "cus_1" } },
		});
		expect(
			await Effect.runPromise(
				provider.verifyEvent(
					new Request("https://api.test", {
						method: "POST",
						headers: {
							"stripe-signature": sdk.webhooks.generateTestHeaderString({
								payload: ignoredBody,
								secret: "whsec_example",
							}),
						},
						body: ignoredBody,
					}),
				),
			),
		).toBeNull();
	});
	test("keeps finalized-invoice usage unresolved instead of acknowledging ingestion", async () => {
		const fake = setup();
		vi.mocked(fake.client.canReportOverage).mockResolvedValue(false);
		await expect(
			Effect.runPromise(fake.provider.reportMeterEvent(meter)),
		).rejects.toMatchObject({ code: "reconciliation-required" });
		expect(fake.client.reportMeter).not.toHaveBeenCalled();
		expect(fake.store.finishDelivery).toHaveBeenCalledWith(
			expect.any(String),
			false,
		);
	});
	test("releases delivery lease on remote failure and retries the same identifier", async () => {
		const fake = setup();
		vi.mocked(fake.client.reportMeter).mockRejectedValueOnce(
			new Error("network lost"),
		);
		await expect(
			Effect.runPromise(fake.provider.reportMeterEvent(meter)),
		).rejects.toMatchObject({ code: "provider-unavailable" });
		expect(fake.store.finishDelivery).toHaveBeenCalledWith(
			expect.any(String),
			false,
		);
		await Effect.runPromise(fake.provider.reportMeterEvent(meter));
		expect(vi.mocked(fake.client.reportMeter).mock.calls[0]?.[1]).toBe(
			vi.mocked(fake.client.reportMeter).mock.calls[1]?.[1],
		);
	});
	test("uses disjoint minute windows for subscription anchors containing seconds", async () => {
		const fake = setup();
		await Effect.runPromise(
			fake.provider.reconcileMeter({
				accountId: "account",
				meterId: "meter",
				periodStartMs: 1789000025000,
				periodEndMs: 1791000005000,
			}),
		);
		expect(fake.client.meterTotal).toHaveBeenCalledWith(
			"cus_1",
			"meter",
			1789000080,
			1791000060,
		);
	});
});

test.each([
	1, 2,
])("SDK customer recovery paginates exact metadata matches (%i)", async (count) => {
	const fake = setup();
	fake.setLinked(null);
	fake.setReservedAt(now - 24 * 60 * 60_000);
	const requests: URL[] = [];
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url,
		);
		requests.push(url);
		if (url.pathname === "/v1/customers") {
			const next = url.searchParams.get("starting_after");
			const data = next
				? Array.from({ length: count }, (_, index) => ({
						id: `cus_match_${index}`,
						object: "customer",
						metadata: { account_id: "account" },
					}))
				: [
						{
							id: "cus_noise",
							object: "customer",
							metadata: { account_id: "account-other" },
						},
					];
			return Response.json({
				object: "list",
				data,
				has_more: !next,
				url: "/v1/customers",
			});
		}
		if (url.pathname === "/v1/customers/cus_match_0")
			return Response.json({
				id: "cus_match_0",
				object: "customer",
				metadata: { account_id: "account" },
			});
		if (url.pathname === "/v1/checkout/sessions")
			return Response.json({
				id: "cs_test",
				url: "https://checkout.stripe.test",
			});
		throw new Error(`unexpected request: ${url.pathname}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	try {
		const provider = makeStripeBillingProvider(config, {
			store: fake.store,
			now: () => now,
		});
		if (!provider.recoverCustomers)
			throw new Error("missing customer recovery");
		expect(await Effect.runPromise(provider.recoverCustomers())).toBe(1);
		expect(requests).toHaveLength(1);
		await expect(
			Effect.runPromise(
				provider.checkout({
					accountId: "account",
					offerId: "cloud-workspace-standard-v1",
					successUrl: "https://api.test",
				}),
			),
		).rejects.toMatchObject({ code: "reconciliation-required" });
		expect(requests).toHaveLength(1);
		expect(await Effect.runPromise(provider.recoverCustomers())).toBe(1);
		const checkout = Effect.runPromise(
			provider.checkout({
				accountId: "account",
				offerId: "cloud-workspace-standard-v1",
				successUrl: "https://api.test",
			}),
		);
		if (count === 2)
			await expect(checkout).rejects.toMatchObject({
				code: "reconciliation-required",
			});
		else {
			await expect(checkout).resolves.toBe("https://checkout.stripe.test");
			expect(await fake.store.getCustomer("account")).toBe("cus_match_0");
		}
		const lists = requests.filter((url) => url.pathname === "/v1/customers");
		expect(lists).toHaveLength(2);
		expect(lists[1]?.searchParams.get("starting_after")).toBe("cus_noise");
		expect(fake.store.renewCustomerReservation).not.toHaveBeenCalled();
	} finally {
		vi.unstubAllGlobals();
	}
});

test("revalidates persisted recovery matches before linking a customer", async () => {
	const fake = setup();
	fake.setLinked(null);
	fake.setReservedAt(now - 24 * 60 * 60_000);
	vi.spyOn(fake.client, "customerPage").mockResolvedValue({
		matches: ["cus_recovered"],
	});
	await Effect.runPromise(fake.provider.recoverCustomers());
	vi.spyOn(fake.client, "customerAccountId").mockResolvedValue("other-account");
	await expect(
		Effect.runPromise(
			fake.provider.checkout({
				accountId: "account",
				offerId: "cloud-workspace-standard-v1",
				successUrl: "https://api.test",
			}),
		),
	).rejects.toMatchObject({ code: "provider-unavailable" });
	expect(await fake.store.getCustomer("account")).toBeNull();
	expect(fake.client.createCheckout).not.toHaveBeenCalled();
});
