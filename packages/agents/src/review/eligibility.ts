/** Hosted subscription review is unavailable until provider-specific proof exists. */
export type ReviewProviderBlockReason =
	| "unsupported-provider"
	| "hosted-subscription-authorization-unverified"
	| "native-tool-confinement-unverified"
	| "durable-native-auth-unverified";

export interface ReviewProviderEligibility {
	readonly providerId: string;
	readonly status: "blocked";
	readonly reasons: readonly ReviewProviderBlockReason[];
}

/**
 * Call before enrollment and again before dispatch. CLI availability, successful
 * login, and user consent cannot establish hosted-review eligibility. There is
 * deliberately no environment flag or caller-provided attestation bypass.
 */
export function getReviewProviderEligibility(
	providerId: string,
): ReviewProviderEligibility {
	if (providerId !== "codex" && providerId !== "claude") {
		return { providerId, status: "blocked", reasons: ["unsupported-provider"] };
	}
	return {
		providerId,
		status: "blocked",
		reasons: [
			"hosted-subscription-authorization-unverified",
			"native-tool-confinement-unverified",
			"durable-native-auth-unverified",
		],
	};
}
