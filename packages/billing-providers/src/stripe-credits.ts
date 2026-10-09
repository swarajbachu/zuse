import { PREPAID_CREDIT_AMOUNTS } from "@zuse/contracts";
import { Effect } from "effect";
import type Stripe from "stripe";
import { BillingProviderError } from "./index.ts";
import type { StripeBillingStore } from "./stripe.ts";
import { deliverStripeOperation } from "./stripe-delivery.ts";

const PURPOSE = "zuse_prepaid_v1";
export interface StripeCreditPurchase {
	readonly id: string;
	readonly accountId: string;
	readonly customerId: string;
	readonly amountCents: number;
	readonly paid: boolean;
	readonly currency: string;
	readonly priceId: string;
	readonly quantity: number;
	readonly chargeId: string;
	readonly disputed: boolean;
	readonly refunds: ReadonlyArray<{
		readonly id: string;
		readonly amount: number;
	}>;
}
export interface StripeCreditClient {
	readonly validatePrice: (id: string) => Promise<void>;
	readonly balance: (customerId: string) => Promise<number>;
	readonly checkout: (
		params: Stripe.Checkout.SessionCreateParams,
	) => Promise<string>;
	readonly purchase: (input: {
		readonly sessionId?: string;
		readonly chargeId?: string;
	}) => Promise<StripeCreditPurchase | null>;
	readonly adjustment: (
		customerId: string,
		amount: number,
		key: string,
		purchaseId: string,
	) => Promise<void>;
}

export const makeStripeCreditClient = (sdk: Stripe): StripeCreditClient => ({
	validatePrice: async (id) => {
		const price = await sdk.prices.retrieve(id);
		if (
			!price.active ||
			price.currency !== "usd" ||
			price.unit_amount !== 100 ||
			price.recurring ||
			price.billing_scheme !== "per_unit" ||
			price.transform_quantity
		)
			throw new Error("invalid_prepaid_price");
	},
	balance: async (id) => {
		const customer = await sdk.customers.retrieve(id);
		if (customer.deleted || (customer.currency && customer.currency !== "usd"))
			throw new Error("invalid_prepaid_customer");
		return customer.balance;
	},
	checkout: async (params) => {
		const session = await sdk.checkout.sessions.create(params);
		if (!session.url) throw new Error("checkout_url_missing");
		return session.url;
	},
	purchase: async ({ sessionId, chargeId }) => {
		if (!sessionId && chargeId) {
			const charge = await sdk.charges.retrieve(chargeId);
			const intent = charge.payment_intent;
			if (!intent) return null;
			const sessions = await sdk.checkout.sessions.list({
				payment_intent: typeof intent === "string" ? intent : intent.id,
				limit: 2,
			});
			if (sessions.data.length !== 1) return null;
			sessionId = sessions.data[0]?.id;
		}
		if (!sessionId) return null;
		const session = await sdk.checkout.sessions.retrieve(sessionId, {
			expand: ["payment_intent.latest_charge", "line_items"],
		});
		if (session.mode !== "payment" || session.metadata?.purpose !== PURPOSE)
			return null;
		const intent = session.payment_intent;
		const charge =
			typeof intent === "object" ? intent?.latest_charge : undefined;
		const items = session.line_items;
		const item = items?.data[0];
		if (
			!charge ||
			typeof charge === "string" ||
			!item ||
			items?.has_more ||
			items.data.length !== 1 ||
			!session.client_reference_id ||
			session.metadata.account_id !== session.client_reference_id ||
			!session.customer ||
			session.amount_total !== charge.amount ||
			charge.currency !== "usd" ||
			(chargeId && charge.id !== chargeId)
		)
			throw new Error("invalid_prepaid_payment");
		const refunds: Array<{ id: string; amount: number }> = [];
		for await (const refund of sdk.refunds.list({
			charge: charge.id,
			limit: 100,
		})) {
			if (refund.status === "succeeded")
				refunds.push({ id: refund.id, amount: refund.amount });
		}
		return {
			id: session.id,
			accountId: session.client_reference_id,
			customerId:
				typeof session.customer === "string"
					? session.customer
					: session.customer.id,
			amountCents: session.amount_total,
			paid:
				session.payment_status === "paid" &&
				charge.paid &&
				charge.captured &&
				charge.amount_captured === charge.amount &&
				typeof intent === "object" &&
				intent?.status === "succeeded" &&
				intent.amount_received === session.amount_total,
			currency: session.currency ?? "",
			priceId: item.price?.id ?? "",
			quantity: item.quantity ?? 0,
			chargeId: charge.id,
			disputed: charge.disputed,
			refunds,
		};
	},
	adjustment: async (customerId, amount, key, purchaseId) => {
		await sdk.customers.createBalanceTransaction(
			customerId,
			{
				amount,
				currency: "usd",
				description: "Zuse prepaid invoice balance",
				metadata: { zuse_operation: key, checkout_id: purchaseId },
			},
			{ idempotencyKey: key },
		);
	},
});

/** Stripe owns invoice consumption; Zuse owns verified, replay-safe funding and reversals. */
export const makeStripeCredits = (input: {
	readonly priceId?: string;
	readonly client: StripeCreditClient;
	readonly store: Pick<
		StripeBillingStore,
		"claimDelivery" | "finishDelivery" | "getCustomer"
	>;
	readonly customer: (
		accountId: string,
		create: boolean,
	) => Effect.Effect<string, BillingProviderError>;
}) => {
	const { client, store, priceId } = input;
	const call = <A>(operation: () => Promise<A>) =>
		Effect.tryPromise({
			try: operation,
			catch: () => new BillingProviderError({ code: "provider-unavailable" }),
		});
	const adjust = (
		purchase: StripeCreditPurchase,
		key: string,
		amount: number,
	) =>
		deliverStripeOperation(
			store,
			key,
			{ customerId: purchase.customerId, amount, purchaseId: purchase.id },
			() => client.adjustment(purchase.customerId, amount, key, purchase.id),
		);

	const reconcile = (purchase: StripeCreditPurchase) =>
		Effect.gen(function* () {
			const customerId = yield* input.customer(purchase.accountId, false);
			if (
				!priceId ||
				purchase.customerId !== customerId ||
				purchase.priceId !== priceId ||
				purchase.currency !== "usd" ||
				!PREPAID_CREDIT_AMOUNTS.some(
					(amount) => amount === purchase.amountCents,
				) ||
				purchase.quantity * 100 !== purchase.amountCents
			)
				return yield* new BillingProviderError({
					code: "reconciliation-required",
				});
			if (!purchase.paid) return;
			if (
				(purchase.disputed && purchase.refunds.length > 0) ||
				purchase.refunds.some(
					(refund) =>
						!Number.isSafeInteger(refund.amount) || refund.amount <= 0,
				) ||
				purchase.refunds.reduce((sum, refund) => sum + refund.amount, 0) >
					purchase.amountCents
			)
				return yield* new BillingProviderError({
					code: "reconciliation-required",
				});
			yield* adjust(
				purchase,
				`prepaid:purchase:${purchase.id}`,
				-purchase.amountCents,
			);
			for (const refund of purchase.refunds) {
				yield* adjust(purchase, `prepaid:refund:${refund.id}`, refund.amount);
			}
		});
	return {
		balance: (accountId: string) =>
			Effect.gen(function* () {
				const linked = yield* call(() => store.getCustomer(accountId));
				const balance =
					linked === null
						? 0
						: yield* input
								.customer(accountId, false)
								.pipe(Effect.flatMap((id) => call(() => client.balance(id))));
				return {
					available: Boolean(priceId),
					creditCents: Math.max(0, -balance),
					debitCents: Math.max(0, balance),
					currency: "usd" as const,
				};
			}),
		checkout: (accountId: string, amountCents: number, successUrl: string) =>
			Effect.gen(function* () {
				if (
					!priceId ||
					!PREPAID_CREDIT_AMOUNTS.some((amount) => amount === amountCents)
				)
					return yield* new BillingProviderError({ code: "checkout-disabled" });
				yield* call(() => client.validatePrice(priceId));
				const customerId = yield* input.customer(accountId, true);
				// Balance can't fund its own purchase; no invoice_creation, promotions or tax on face value.
				return yield* call(() =>
					client.checkout({
						mode: "payment",
						customer: customerId,
						client_reference_id: accountId,
						allowed_payment_method_types: ["card"],
						success_url: successUrl,
						line_items: [{ price: priceId, quantity: amountCents / 100 }],
						metadata: { purpose: PURPOSE, account_id: accountId },
						payment_intent_data: {
							metadata: { purpose: PURPOSE, account_id: accountId },
						},
					}),
				);
			}),
		process: (event: Stripe.Event) =>
			Effect.gen(function* () {
				let purchase: StripeCreditPurchase | null;
				let dispute:
					| {
							readonly id: string;
							readonly amount: number;
							readonly reinstated: boolean;
					  }
					| undefined;
				switch (event.type) {
					case "checkout.session.completed":
					case "checkout.session.async_payment_succeeded":
						purchase = yield* call(() =>
							client.purchase({ sessionId: event.data.object.id }),
						);
						break;
					case "charge.dispute.funds_withdrawn":
					case "charge.dispute.funds_reinstated": {
						const value = event.data.object;
						const chargeId =
							typeof value.charge === "string" ? value.charge : value.charge.id;
						purchase = yield* call(() => client.purchase({ chargeId }));
						dispute = {
							id: value.id,
							amount: value.amount,
							reinstated: event.type === "charge.dispute.funds_reinstated",
						};
						break;
					}
					case "charge.refunded":
						purchase = yield* call(() =>
							client.purchase({ chargeId: event.data.object.id }),
						);
						break;
					case "refund.updated": {
						const charge = event.data.object.charge;
						if (!charge) return false;
						purchase = yield* call(() =>
							client.purchase({
								chargeId: typeof charge === "string" ? charge : charge.id,
							}),
						);
						break;
					}
					default:
						return false;
				}
				if (purchase) {
					if (
						dispute &&
						(purchase.refunds.length > 0 ||
							!Number.isSafeInteger(dispute.amount) ||
							dispute.amount <= 0 ||
							dispute.amount > purchase.amountCents)
					)
						return yield* new BillingProviderError({
							code: "reconciliation-required",
						});
					yield* reconcile(purchase);
					if (dispute && purchase.paid) {
						// Reinstatement may arrive first: establish withdrawal before reversing it.
						yield* adjust(
							purchase,
							`prepaid:dispute:${dispute.id}:withdrawn`,
							dispute.amount,
						);
						if (dispute.reinstated)
							yield* adjust(
								purchase,
								`prepaid:dispute:${dispute.id}:reinstated`,
								-dispute.amount,
							);
					}
				}
				return true;
			}),
	};
};
