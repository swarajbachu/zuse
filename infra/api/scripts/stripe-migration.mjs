/** Exact renewal boundaries and stable identities are mandatory. No implicit
 * re-pricing, balance transfer or payment-method copying is permitted. */
export const validateMigrationManifest = (input, nowMs) => {
	if (!Array.isArray(input) || input.length === 0)
		throw new Error("Expected a nonempty migration manifest");
	const accounts = new Set();
	const subscriptions = new Set();
	const customers = new Set();
	for (const item of input) {
		if (
			!item ||
			typeof item.accountId !== "string" ||
			!item.accountId.trim() ||
			typeof item.polarSubscriptionId !== "string" ||
			!item.polarSubscriptionId.trim() ||
			typeof item.stripeCustomerId !== "string" ||
			!item.stripeCustomerId.startsWith("cus_") ||
			item.offerId !== "cloud-workspace-standard-v1" ||
			!Number.isSafeInteger(item.renewalAtMs) ||
			item.renewalAtMs % 1000 !== 0 ||
			item.renewalAtMs <= nowMs
		)
			throw new Error("Invalid cloud subscription migration entry");
		if (
			accounts.has(item.accountId) ||
			subscriptions.has(item.polarSubscriptionId) ||
			customers.has(item.stripeCustomerId)
		)
			throw new Error("Duplicate migration identity");
		accounts.add(item.accountId);
		subscriptions.add(item.polarSubscriptionId);
		customers.add(item.stripeCustomerId);
	}
	return input;
};
export const migrationScheduleParams = (item, basePrice, overagePrice) => {
	if (!basePrice || !overagePrice || basePrice === overagePrice)
		throw new Error("Configure distinct Stripe base and overage prices");
	return {
		customer: item.stripeCustomerId,
		start_date: item.renewalAtMs / 1000,
		end_behavior: "release",
		metadata: {
			account_id: item.accountId,
			polar_subscription_id: item.polarSubscriptionId,
		},
		phases: [
			{
				items: [{ price: basePrice, quantity: 1 }, { price: overagePrice }],
				duration: { interval: "month", interval_count: 1 },
				proration_behavior: "none",
				metadata: {
					account_id: item.accountId,
					offer_id: item.offerId,
					polar_subscription_id: item.polarSubscriptionId,
				},
			},
		],
		default_settings: { automatic_tax: { enabled: true } },
	};
};
