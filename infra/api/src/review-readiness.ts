import { getReviewProviderEligibility } from "@zuse/agents/review/eligibility";
/** This gate must be removed by verified implementations, never an environment flag. */
export const REVIEW_INFRASTRUCTURE_BLOCKERS = Object.freeze([
	"authenticated-browser-setup-unavailable",
	"native-review-dispatch-unavailable",
	"review-compute-reservations-unverified",
	"review-publication-transport-unverified",
] as const);
export const getReviewReadiness = (provider: string) => {
	const eligibility = getReviewProviderEligibility(provider);
	return {
		provider,
		available: false,
		reasons: [...eligibility.reasons, ...REVIEW_INFRASTRUCTURE_BLOCKERS],
	};
};
