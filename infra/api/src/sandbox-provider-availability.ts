/** Paid boxd placement requires an explicit provider cutover at whole-second precision. */
export const boxdBillingConfigured = (
	enabled: string | undefined,
	cutover: string | undefined,
): boolean => {
	const timestamp = Date.parse(cutover ?? "");
	return (
		enabled === "true" &&
		Number.isSafeInteger(timestamp) &&
		timestamp > 0 &&
		timestamp % 1000 === 0
	);
};

// Boxd billing requires an explicit opt-in to completed USD provider estimates.
export const supportsSandboxBilling = (
	providerId: string,
	billingEnforced: boolean,
	boxdBillingEnabled = false,
): boolean => !billingEnforced || providerId !== "boxd" || boxdBillingEnabled;

export const availableSandboxProviders = (
	providers: ReadonlyArray<{
		readonly providerId: string;
		readonly advertised: boolean;
		readonly productionReady: boolean;
	}>,
	sandbox: boolean,
	billingEnforced: boolean,
	boxdBillingEnabled = false,
): Set<string> =>
	new Set(
		providers
			.filter(
				(provider) =>
					provider.advertised &&
					(sandbox || provider.productionReady) &&
					supportsSandboxBilling(
						provider.providerId,
						billingEnforced,
						boxdBillingEnabled,
					),
			)
			.map((provider) => provider.providerId),
	);
