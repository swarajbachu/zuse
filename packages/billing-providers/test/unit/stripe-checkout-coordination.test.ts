import { Effect, Redacted } from "effect";
import Stripe from "stripe";
import { afterEach, expect, test, vi } from "vitest";
import {
	makeStripeBillingProvider,
	type StripeBillingStore,
} from "../../src/stripe.ts";

const purchase = {
	id: "cs_credit",
	mode: "payment",
	customer: "cus_1",
	client_reference_id: "account",
	metadata: {
		account_id: "account",
		purpose: "zuse_prepaid_v1",
		activate_pro: "true",
	},
	amount_total: 20000,
	currency: "usd",
	payment_status: "paid",
	line_items: {
		data: [{ price: { id: "credit" }, quantity: 200 }],
		has_more: false,
	},
	payment_intent: {
		status: "succeeded",
		amount_received: 20000,
		latest_charge: {
			id: "ch_1",
			amount: 20000,
			amount_captured: 20000,
			currency: "usd",
			paid: true,
			captured: true,
			disputed: false,
		},
	},
};
afterEach(() => vi.restoreAllMocks());
const fixture = () => {
	const sessions: Array<{
		id: string;
		mode: string;
		status: string;
		customer: string;
		metadata: Record<string, string>;
		subscription?: string;
		url: string;
	}> = [];
	const subscriptions: Array<{
		id: string;
		status: string;
		metadata: Record<string, string>;
		items: { data: Array<{ price: { id: string } }> };
	}> = [];
	let completesDuringExpiry = false;
	let expiryUnavailable = false;
	let grants = 0;
	const subscription = () => {
		const value = {
			id: `sub_${subscriptions.length + 1}`,
			status: "active",
			metadata: {
				account_id: "account",
				offer_id: "cloud-workspace-standard-v1",
			},
			items: { data: [{ price: { id: "base" } }] },
		};
		subscriptions.push(value);
		return value;
	};
	const http = Stripe.createFetchHttpClient(async (url, init) => {
		const parsed = new URL(String(url)),
			path = parsed.pathname,
			params = new URLSearchParams(String(init?.body ?? ""));
		let value: unknown;
		if (path === "/v1/customers/cus_1")
			value = { id: "cus_1", metadata: { account_id: "account" } };
		else if (path === "/v1/checkout/sessions/cs_credit") value = purchase;
		else if (path === "/v1/refunds") value = { data: [], has_more: false };
		else if (path === "/v1/customers/cus_1/balance_transactions") {
			grants++;
			value = { id: "balance_1" };
		} else if (path === "/v1/subscriptions")
			value =
				init?.method === "POST"
					? subscription()
					: {
							data: completesDuringExpiry ? [] : subscriptions,
							has_more: false,
						};
		else if (path.startsWith("/v1/subscriptions/"))
			value = subscriptions.find((s) => s.id === path.split("/").at(-1));
		else if (path === "/v1/checkout/sessions" && init?.method === "POST") {
			const session = {
				id: `cs_${sessions.length + 1}`,
				mode: params.get("mode") ?? "",
				status: "open",
				customer: "cus_1",
				metadata: {
					account_id: "account",
					offer_id: "cloud-workspace-standard-v1",
				},
				url: "https://checkout.test/normal",
			};
			sessions.push(session);
			value = session;
		} else if (path === "/v1/checkout/sessions")
			value = {
				data: sessions.filter((s) => s.status === "open"),
				has_more: false,
			};
		else if (path.endsWith("/expire")) {
			const session = sessions.find((s) => path.includes(`/${s.id}/`));
			if (!session) throw new Error("Unknown session");
			if (expiryUnavailable)
				return new Response(
					JSON.stringify({
						error: {
							type: "invalid_request_error",
							message: "Checkout cannot be expired yet",
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			if (completesDuringExpiry) {
				session.status = "complete";
				session.subscription = subscription().id;
				return new Response(
					JSON.stringify({
						error: {
							type: "invalid_request_error",
							message: "Session is no longer open",
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}
			session.status = "expired";
			value = session;
		} else if (path.endsWith("/line_items"))
			value = { data: [{ price: { id: "base" } }], has_more: false };
		else if (path.startsWith("/v1/checkout/sessions/"))
			value = sessions.find((s) => path.endsWith(`/${s.id}`));
		else throw new Error(`Unexpected Stripe request ${path}`);
		return new Response(JSON.stringify(value), {
			headers: { "content-type": "application/json" },
		});
	});
	vi.spyOn(Stripe, "createFetchHttpClient").mockReturnValue(http);
	let tail = Promise.resolve();
	const receipts = new Set<string>();
	const store: StripeBillingStore = {
		getCustomer: async () => "cus_1",
		reserveCustomer: async () => ({
			customerId: "cus_1",
			createdAtMs: Date.now(),
			generation: 0,
			recoveryMatches: [],
			recoveryComplete: false,
		}),
		renewCustomerReservation: async () => {
			throw new Error("Unused");
		},
		linkCustomer: async () => {},
		claimCustomerRecoveries: async () => [],
		finishCustomerRecovery: async () => {},
		claimDelivery: async (key) => (receipts.has(key) ? "sent" : "send"),
		finishDelivery: async (key, sent) => {
			if (sent) receipts.add(key);
		},
		withSubscriptionLock: async (_account, operation) => {
			const previous = tail;
			let release = () => {};
			tail = new Promise<void>((r) => {
				release = r;
			});
			await previous;
			try {
				return await operation();
			} finally {
				release();
			}
		},
	};
	const provider = makeStripeBillingProvider(
		{
			secretKey: Redacted.make("sk_test_fixture"),
			webhookSecret: Redacted.make("whsec_fixture"),
			offerPrices: { "cloud-workspace-standard-v1": "base" },
			cloudOveragePriceId: "overage",
			prepaidCreditPriceId: "credit",
			automaticTaxEnabled: false,
			portalReturnUrl: "https://api.test",
		},
		{
			store,
			verifyWebhook: async () =>
				JSON.parse(
					JSON.stringify({
						id: "evt_credit",
						type: "checkout.session.completed",
						data: { object: { id: "cs_credit" } },
					}),
				),
		},
	);
	const checkout = () =>
		Effect.runPromise(
			provider.checkout({
				accountId: "account",
				offerId: "cloud-workspace-standard-v1",
				successUrl: "https://api.test",
			}),
		);
	const activate = () =>
		Effect.runPromise(
			provider.verifyEvent(
				new Request("https://api.test/webhook", {
					method: "POST",
					headers: { "stripe-signature": "test" },
					body: "{}",
				}),
			),
		);
	return {
		checkout,
		activate,
		sessions,
		subscriptions,
		grants: () => grants,
		setExpiryUnavailable: (value: boolean) => {
			expiryUnavailable = value;
		},
		completeDuringExpiry: () => {
			completesDuringExpiry = true;
		},
	};
};
test("prepaid activation expires an older normal checkout before creating Pro", async () => {
	const f = fixture();
	await f.checkout();
	await f.activate();
	expect(f.sessions[0]?.status).toBe("expired");
	expect(f.subscriptions).toHaveLength(1);
});
test("a normal checkout opened after prepaid activation cannot create another subscription", async () => {
	const f = fixture();
	await f.activate();
	await expect(f.checkout()).rejects.toMatchObject({
		code: "checkout-disabled",
	});
	expect(f.sessions).toHaveLength(0);
	expect(f.subscriptions).toHaveLength(1);
});
test("normal checkout and prepaid activation racing still leave no payable duplicate checkout", async () => {
	const f = fixture();
	await Promise.allSettled([f.checkout(), f.activate()]);
	expect(f.sessions.every((s) => s.status === "expired")).toBe(true);
	expect(f.subscriptions).toHaveLength(1);
});
test("a normal checkout completing while expiry runs is adopted without creating another subscription", async () => {
	const f = fixture();
	await f.checkout();
	f.completeDuringExpiry();
	await f.activate();
	expect(f.sessions[0]?.status).toBe("complete");
	expect(f.subscriptions).toHaveLength(1);
});

test("unconfirmed checkout expiry blocks activation and retries without double funding", async () => {
	const f = fixture();
	await f.checkout();
	f.setExpiryUnavailable(true);
	await expect(f.activate()).rejects.toMatchObject({
		code: "reconciliation-required",
	});
	expect(f.subscriptions).toHaveLength(0);
	expect(f.grants()).toBe(1);
	f.setExpiryUnavailable(false);
	await f.activate();
	expect(f.subscriptions).toHaveLength(1);
	expect(f.sessions[0]?.status).toBe("expired");
	expect(f.grants()).toBe(1);
});
test("older normal checkouts missing offer metadata are matched by their actual price", async () => {
	const f = fixture();
	await f.checkout();
	const session = f.sessions[0];
	if (!session) throw new Error("Missing normal checkout");
	delete session.metadata.offer_id;
	await f.activate();
	expect(session.status).toBe("expired");
	expect(f.subscriptions).toHaveLength(1);
});
