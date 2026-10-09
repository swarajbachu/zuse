/** Stripe account keys include both unrestricted and permission-scoped keys. */
export const stripeKeyEnvironment = (
	key: string | undefined,
): "production" | "sandbox" | undefined => {
	if (/^(?:sk|rk)_live_/.test(key ?? "")) return "production";
	if (/^(?:sk|rk)_test_/.test(key ?? "")) return "sandbox";
	return undefined;
};
