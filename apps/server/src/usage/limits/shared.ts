import type { ProviderId, ProviderUsageLimits } from "@zuse/contracts";

export const unavailable = (
	providerId: ProviderId,
	unavailableReason: NonNullable<ProviderUsageLimits["unavailableReason"]>,
): ProviderUsageLimits => ({
	providerId,
	planLabel: null,
	windows: [],
	creditsRemaining: null,
	fetchedAt: new Date().toISOString(),
	source: "api",
	unavailableReason,
});

export { normalizePercent, normalizeReset } from "@zuse/utils/usage-values";
