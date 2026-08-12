import type { ProviderId, ProviderUsageLimits } from "@zuse/contracts";

import { PROVIDER_DISPLAY } from "./provider-status";

export const usageLimitsUnavailableLabel = (
	providerId: ProviderId,
	reason: ProviderUsageLimits["unavailableReason"],
): string => {
	const providerName = PROVIDER_DISPLAY[providerId];
	if (reason === "unsupported") return "Not available for this account";
	if (reason === "scope-missing")
		return "Usage limits unavailable for this scope";
	if (reason === "no-credentials") {
		return providerId === "kiro"
			? "Sign in with kiro-cli login to see limits"
			: `Sign in to ${providerName} to see limits`;
	}
	if (reason === "expired") {
		return providerId === "kiro"
			? "Session expired: run kiro-cli login"
			: `${providerName} session expired: sign in again`;
	}
	if (reason === "error") return "Could not load limits: try again";
	return "No usage data available";
};
