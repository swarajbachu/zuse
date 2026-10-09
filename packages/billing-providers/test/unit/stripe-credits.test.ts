import { Effect } from "effect";
import Stripe from "stripe";
import { describe, expect, test, vi } from "vitest";
import {
	makeStripeCreditClient,
	makeStripeCredits,
	type StripeCreditClient,
	type StripeCreditPurchase,
} from "../../src/stripe-credits.ts";

const event = (
	type: Stripe.Event.Type,
	object: unknown = { id: "cs_paid" },
): Stripe.Event =>
	JSON.parse(JSON.stringify({ id: "evt_1", type, data: { object } }));
const fixture = () => {
	let purchase: StripeCreditPurchase | null = {
		id: "cs_paid",
		accountId: "account",
		customerId: "cus_1",
		amountCents: 2500,
		paid: true,
		currency: "usd",
		priceId: "price_credit",
		quantity: 25,
		chargeId: "ch_1",
		disputed: false,
		refunds: [],
	};
	let linked: string | null = "cus_1";
	let balance = 0;
	let failAck = false;
	let expired = false;
	const receipts = new Map<
		string,
		{ payload: string; sent: boolean; busy: boolean }
	>();
	const remote = new Map<string, number>();
	const client: StripeCreditClient = {
		validatePrice: vi.fn(async () => {}),
		balance: vi.fn(async () => balance),
		checkout: vi.fn(async () => "https://checkout.stripe.com/test"),
		purchase: vi.fn(async () => purchase),
		adjustment: vi.fn(async (_customer, amount, key) => {
			if (!remote.has(key)) {
				remote.set(key, amount);
				balance += amount;
			}
		}),
	};
	const store = {
		getCustomer: async () => linked,
		claimDelivery: async (
			key: string,
			payload: string,
		): Promise<"send" | "sent" | "busy" | "expired"> => {
			const previous = receipts.get(key);
			if (previous && previous.payload !== payload)
				throw new Error("changed payload");
			if (previous?.sent) return "sent";
			if (expired) return "expired";
			if (previous?.busy) return "busy";
			receipts.set(key, { payload, busy: true, sent: false });
			return "send";
		},
		finishDelivery: async (key: string, sent: boolean) => {
			const receipt = receipts.get(key);
			if (failAck) {
				failAck = false;
				if (receipt) receipt.busy = false;
				throw new Error("lost database acknowledgement");
			}
			if (receipt) {
				receipt.sent = sent;
				receipt.busy = false;
			}
		},
	};
	const customer = vi.fn((_account: string, _create: boolean) =>
		Effect.succeed("cus_1"),
	);
	const credits = makeStripeCredits({
		priceId: "price_credit",
		client,
		store,
		customer,
	});
	return {
		client,
		store,
		customer,
		credits,
		remote,
		getBalance: () => balance,
		setBalance: (value: number) => {
			balance = value;
		},
		setLinked: (value: string | null) => {
			linked = value;
		},
		setPurchase: (overrides: Partial<StripeCreditPurchase> | null) => {
			if (overrides === null) purchase = null;
			else if (purchase) purchase = { ...purchase, ...overrides };
			else throw new Error("No purchase fixture");
		},
		expire: () => {
			expired = true;
		},
		failAck: () => {
			failAck = true;
		},
	};
};

describe("prepaid invoice balance", () => {
	test("collects face value independently of existing credit and sends no subscription or invoice-creation flags", async () => {
		const f = fixture();
		f.setBalance(-10000);
		await Effect.runPromise(
			f.credits.checkout("account", 2500, "https://api.test/complete"),
		);
		expect(f.client.validatePrice).toHaveBeenCalledWith("price_credit");
		expect(f.client.checkout).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "payment",
				allowed_payment_method_types: ["card"],
				customer: "cus_1",
				line_items: [{ price: "price_credit", quantity: 25 }],
				client_reference_id: "account",
			}),
		);
		const params = vi.mocked(f.client.checkout).mock.calls[0]?.[0];
		expect(params).not.toHaveProperty("invoice_creation");
		expect(params).not.toHaveProperty("subscription_data");
		expect(params).not.toHaveProperty("allow_promotion_codes");
		expect(f.getBalance()).toBe(-10000);
	});
	test.each([
		0, -1000, 1001, 100000, 25.5,
	])("rejects invalid amounts before creating a customer: %s", async (amount) => {
		const f = fixture();
		await expect(
			Effect.runPromise(
				f.credits.checkout("account", amount, "https://api.test"),
			),
		).rejects.toMatchObject({ code: "checkout-disabled" });
		expect(f.customer).not.toHaveBeenCalled();
	});
	test("missing price disables purchases but preserves existing balance visibility and creates no new customer", async () => {
		const f = fixture();
		f.setBalance(-3500);
		const disabled = makeStripeCredits({
			client: f.client,
			store: f.store,
			customer: f.customer,
		});
		expect(await Effect.runPromise(disabled.balance("account"))).toEqual({
			available: false,
			creditCents: 3500,
			debitCents: 0,
			currency: "usd",
		});
		await expect(
			Effect.runPromise(disabled.checkout("account", 2500, "https://api.test")),
		).rejects.toMatchObject({ code: "checkout-disabled" });
		f.setLinked(null);
		f.customer.mockClear();
		expect((await Effect.runPromise(disabled.balance("new"))).creditCents).toBe(
			0,
		);
		expect(f.customer).not.toHaveBeenCalled();
	});
	test("only confirmed payment grants credit; duplicate events grant once", async () => {
		const f = fixture();
		f.setPurchase({ paid: false });
		await Effect.runPromise(
			f.credits.process(event("checkout.session.completed")),
		);
		expect(f.remote.size).toBe(0);
		f.setPurchase({ paid: true });
		await Effect.runPromise(
			f.credits.process(event("checkout.session.async_payment_succeeded")),
		);
		await Effect.runPromise(
			f.credits.process(event("checkout.session.completed")),
		);
		expect(f.getBalance()).toBe(-2500);
		expect(f.remote.size).toBe(1);
	});
	test.each([
		{ customerId: "cus_other" },
		{ priceId: "price_other" },
		{ currency: "eur" },
		{ quantity: 26 },
		{ amountCents: 2600 },
		{ refunds: [{ id: "re_1", amount: 3000 }] },
	])("rejects inconsistent payments before any adjustment: %j", async (overrides) => {
		const f = fixture();
		f.setPurchase(overrides);
		await expect(
			Effect.runPromise(f.credits.process(event("checkout.session.completed"))),
		).rejects.toMatchObject({ code: "reconciliation-required" });
		expect(f.remote.size).toBe(0);
	});
	test("refund delivered before checkout grants only net paid value; subsequent partial refunds reverse once", async () => {
		const f = fixture();
		f.setPurchase({ refunds: [{ id: "re_1", amount: 500 }] });
		await Effect.runPromise(
			f.credits.process(event("charge.refunded", { id: "ch_1" })),
		);
		await Effect.runPromise(
			f.credits.process(event("checkout.session.completed")),
		);
		expect(f.getBalance()).toBe(-2000);
		f.setPurchase({
			refunds: [
				{ id: "re_1", amount: 500 },
				{ id: "re_2", amount: 2000 },
			],
		});
		await Effect.runPromise(
			f.credits.process(event("refund.updated", { charge: "ch_1" })),
		);
		await Effect.runPromise(
			f.credits.process(event("charge.refunded", { id: "ch_1" })),
		);
		expect(f.getBalance()).toBe(0);
		expect(f.remote.size).toBe(3);
	});
	test("refund of already-spent credit becomes invoice debit rather than free consumed service", async () => {
		const f = fixture();
		await Effect.runPromise(
			f.credits.process(event("checkout.session.completed")),
		);
		f.setBalance(0); // Stripe applied the credit to an invoice.
		f.setPurchase({ refunds: [{ id: "re_full", amount: 2500 }] });
		await Effect.runPromise(
			f.credits.process(event("charge.refunded", { id: "ch_1" })),
		);
		expect(await Effect.runPromise(f.credits.balance("account"))).toMatchObject(
			{ creditCents: 0, debitCents: 2500 },
		);
	});
	test("lost local acknowledgement retries the same Stripe operation without duplicate funds", async () => {
		const f = fixture();
		f.failAck();
		await expect(
			Effect.runPromise(f.credits.process(event("checkout.session.completed"))),
		).rejects.toMatchObject({ code: "provider-unavailable" });
		expect(f.getBalance()).toBe(-2500);
		await Effect.runPromise(
			f.credits.process(event("checkout.session.completed")),
		);
		expect(f.getBalance()).toBe(-2500);
		expect(f.client.adjustment).toHaveBeenCalledTimes(2);
		expect(f.remote.size).toBe(1);
	});
	test("concurrent events lease one grant and retry to converge", async () => {
		const f = fixture();
		const results = await Promise.allSettled([
			Effect.runPromise(f.credits.process(event("checkout.session.completed"))),
			Effect.runPromise(f.credits.process(event("checkout.session.completed"))),
		]);
		expect(results.some((result) => result.status === "fulfilled")).toBe(true);
		await Effect.runPromise(
			f.credits.process(event("checkout.session.completed")),
		);
		expect(f.remote.size).toBe(1);
	});
	test("ambiguous expired writes fail closed, never use a fresh key", async () => {
		const f = fixture();
		f.expire();
		await expect(
			Effect.runPromise(f.credits.process(event("checkout.session.completed"))),
		).rejects.toMatchObject({ code: "reconciliation-required" });
		expect(f.client.adjustment).not.toHaveBeenCalled();
	});
	test("dispute withdrawal removes purchased funds and reinstatement restores once even out of order", async () => {
		const f = fixture();
		const dispute = { id: "dp_1", charge: "ch_1", amount: 2500 };
		await Effect.runPromise(
			f.credits.process(event("charge.dispute.funds_reinstated", dispute)),
		);
		await Effect.runPromise(
			f.credits.process(event("charge.dispute.funds_withdrawn", dispute)),
		);
		expect(f.getBalance()).toBe(-2500);
		expect(f.remote.size).toBe(3);
	});
	test("withdrawn dispute and refunded charge require reconciliation, never subtract both", async () => {
		const f = fixture();
		f.setPurchase({ disputed: true, refunds: [{ id: "re_1", amount: 1000 }] });
		await expect(
			Effect.runPromise(
				f.credits.process(event("charge.refunded", { id: "ch_1" })),
			),
		).rejects.toMatchObject({ code: "reconciliation-required" });
		expect(f.remote.size).toBe(0);
	});
	test("unrelated subscriptions and payments do not change invoice credit", async () => {
		const f = fixture();
		f.setPurchase(null);
		expect(
			await Effect.runPromise(
				f.credits.process(event("customer.subscription.created")),
			),
		).toBe(false);
		await Effect.runPromise(
			f.credits.process(event("checkout.session.completed")),
		);
		expect(f.remote.size).toBe(0);
	});
});

describe("Stripe SDK credit transport", () => {
	const sdkFixture = () => {
		let session = {
			id: "cs_1",
			mode: "payment",
			metadata: { purpose: "zuse_prepaid_v1", account_id: "account" },
			client_reference_id: "account",
			customer: "cus_1",
			amount_total: 2500,
			currency: "usd",
			payment_status: "paid",
			payment_intent: {
				id: "pi_1",
				status: "succeeded",
				amount_received: 2500,
				latest_charge: {
					id: "ch_1",
					amount: 2500,
					amount_captured: 2500,
					currency: "usd",
					paid: true,
					captured: true,
					disputed: false,
				},
			},
			line_items: {
				has_more: false,
				data: [{ price: { id: "price_credit" }, quantity: 25 }],
			},
		};
		let price = {
			active: true,
			currency: "usd",
			unit_amount: 100,
			recurring: null,
			billing_scheme: "per_unit",
			transform_quantity: null,
		};
		const requests: Array<{ path: string; body: string; key?: string }> = [];
		const http = Stripe.createFetchHttpClient(async (url, init) => {
			const path = new URL(String(url)).pathname;
			const headers = new Headers(init?.headers);
			requests.push({
				path,
				body: String(init?.body ?? ""),
				key: headers.get("Idempotency-Key") ?? undefined,
			});
			let value: unknown;
			if (path === "/v1/prices/price_credit") value = price;
			else if (path === "/v1/checkout/sessions/cs_1") value = session;
			else if (path === "/v1/charges/ch_1")
				value = { id: "ch_1", payment_intent: "pi_1" };
			else if (path === "/v1/checkout/sessions")
				value = { data: [{ id: "cs_1" }], has_more: false };
			else if (path === "/v1/refunds")
				value = {
					data: [
						{ id: "re_pending", amount: 500, status: "pending" },
						{ id: "re_paid", amount: 1000, status: "succeeded" },
					],
					has_more: false,
				};
			else if (path === "/v1/customers/cus_1/balance_transactions")
				value = { id: "cbtxn_1" };
			else throw new Error(`unexpected Stripe request ${path}`);
			return new Response(JSON.stringify(value), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const client = makeStripeCreditClient(
			new Stripe("sk_test_local", { httpClient: http, maxNetworkRetries: 0 }),
		);
		return {
			client,
			requests,
			changeSession: (value: Partial<typeof session>) => {
				session = { ...session, ...value };
			},
			changePrice: (value: Partial<typeof price>) => {
				price = { ...price, ...value };
			},
		};
	};
	test("fetches canonical paid session, charge and only successful refunds rather than trusting webhook amounts", async () => {
		const f = sdkFixture();
		const purchase = await f.client.purchase({ chargeId: "ch_1" });
		expect(purchase).toMatchObject({
			id: "cs_1",
			customerId: "cus_1",
			amountCents: 2500,
			paid: true,
			refunds: [{ id: "re_paid", amount: 1000 }],
		});
		expect(f.requests.map((request) => request.path)).toEqual([
			"/v1/charges/ch_1",
			"/v1/checkout/sessions",
			"/v1/checkout/sessions/cs_1",
			"/v1/refunds",
		]);
	});
	test("unrelated checkout and inconsistent charge ownership are rejected", async () => {
		const f = sdkFixture();
		f.changeSession({ metadata: { purpose: "other", account_id: "account" } });
		expect(await f.client.purchase({ sessionId: "cs_1" })).toBeNull();
		f.changeSession({
			metadata: { purpose: "zuse_prepaid_v1", account_id: "attacker" },
		});
		await expect(f.client.purchase({ sessionId: "cs_1" })).rejects.toThrow(
			"invalid_prepaid_payment",
		);
	});
	test("partially captured funds never grant the whole checkout value", async () => {
		const f = sdkFixture();
		f.changeSession({
			payment_intent: {
				id: "pi_1",
				status: "succeeded",
				amount_received: 1000,
				latest_charge: {
					id: "ch_1",
					amount: 2500,
					amount_captured: 1000,
					currency: "usd",
					paid: true,
					captured: true,
					disputed: false,
				},
			},
		});
		expect((await f.client.purchase({ sessionId: "cs_1" }))?.paid).toBe(false);
	});

	test("validates the configured face-value price and persists immutable adjustment with the durable key", async () => {
		const f = sdkFixture();
		await f.client.validatePrice("price_credit");
		f.changePrice({ unit_amount: 200 });
		await expect(f.client.validatePrice("price_credit")).rejects.toThrow(
			"invalid_prepaid_price",
		);
		await f.client.adjustment("cus_1", -2500, "prepaid:purchase:cs_1", "cs_1");
		const request = f.requests.at(-1);
		expect(request?.key).toBe("prepaid:purchase:cs_1");
		const params = new URLSearchParams(request?.body);
		expect(params.get("amount")).toBe("-2500");
		expect(params.get("currency")).toBe("usd");
		expect(params.get("metadata[checkout_id]")).toBe("cs_1");
	});
});
