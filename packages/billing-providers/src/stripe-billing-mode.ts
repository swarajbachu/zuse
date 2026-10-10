export type StripeCloudBillingMode = "metered" | "subscription-only";

/** An explicit subscription-only launch must not attach a usage price. */
export const resolveStripeCloudBillingMode = (
	value: string | undefined,
): StripeCloudBillingMode => {
	const mode = value ?? "metered";
	if (mode !== "metered" && mode !== "subscription-only")
		throw new Error("invalid_stripe_cloud_billing_mode");
	return mode;
};
