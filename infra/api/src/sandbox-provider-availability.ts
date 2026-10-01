// Boxd has no usage settlement source yet. Keep this policy shared by runtime
// placement and deployment validation. Estimated balance enforcement is an explicit opt-in.
export const supportsSandboxBilling = (
	providerId: string,
	billingEnforced: boolean,
	boxdEstimatesEnabled = false,
): boolean => !billingEnforced || providerId !== "boxd" || boxdEstimatesEnabled;

export const availableSandboxProviders = (
	providers: ReadonlyArray<{
		readonly providerId: string;
		readonly advertised: boolean;
		readonly productionReady: boolean;
	}>,
	sandbox: boolean,
	billingEnforced: boolean,
	boxdEstimatesEnabled = false,
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
						boxdEstimatesEnabled,
					),
			)
			.map((provider) => provider.providerId),
	);
