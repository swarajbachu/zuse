import type Stripe from "stripe";
import { BillingProviderError } from "./index.ts";

/** Normal checkout and prepaid activation must subscribe to the same price items. */
export const stripeSubscriptionItems = (
	basePriceId: string,
	overagePriceId?: string,
): Array<{ price: string; quantity?: number }> => [
	{ price: basePriceId, quantity: 1 },
	...(overagePriceId ? [{ price: overagePriceId }] : []),
];

/** Close old purchase URLs before deciding whether this customer needs a subscription.
 * A checkout completing during expiry must be read canonically before creating anything. */
export const stripeSubscriptionsAfterCheckoutExpiry = async (
	sdk: Stripe,
	input: {
		customerId: string;
		accountId: string;
		offerId: string;
		basePriceId: string;
	},
): Promise<ReadonlyArray<Stripe.Subscription>> => {
	const completed = new Map<string, Stripe.Subscription>();
	for await (const session of sdk.checkout.sessions.list({
		customer: input.customerId,
		status: "open",
		limit: 100,
	})) {
		if (session.mode !== "subscription") continue;
		if (session.metadata?.offer_id !== input.offerId) {
			if (session.metadata?.offer_id) continue;
			let matching = false;
			for await (const item of sdk.checkout.sessions.listLineItems(session.id, {
				limit: 100,
			})) {
				if (item.price?.id === input.basePriceId) matching = true;
			}
			if (!matching) continue;
		}
		if (
			(session.metadata?.account_id &&
				session.metadata.account_id !== input.accountId) ||
			(session.client_reference_id &&
				session.client_reference_id !== input.accountId)
		)
			throw new BillingProviderError({ code: "reconciliation-required" });
		try {
			await sdk.checkout.sessions.expire(session.id);
		} catch {
			const current = await sdk.checkout.sessions.retrieve(session.id);
			if (current.status === "expired") continue;
			if (current.status !== "complete" || !current.subscription)
				throw new BillingProviderError({ code: "reconciliation-required" });
			const id =
				typeof current.subscription === "string"
					? current.subscription
					: current.subscription.id;
			completed.set(id, await sdk.subscriptions.retrieve(id));
		}
	}
	const subscriptions = new Map<string, Stripe.Subscription>();
	for await (const subscription of sdk.subscriptions.list({
		customer: input.customerId,
		status: "all",
		limit: 100,
	}))
		subscriptions.set(subscription.id, subscription);
	for (const [id, subscription] of completed)
		subscriptions.set(id, subscription);
	return [...subscriptions.values()];
};
