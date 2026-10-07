import { getReviewProviderEligibility } from "@zuse/agents/review/eligibility";
import type { ApiConfig } from "./config.ts";
/** Only release evidence and explicit deployment enablement gate implemented execution. */
export const REVIEW_INFRASTRUCTURE_BLOCKERS = Object.freeze([] as string[]);
export const getReviewReadiness = (
	provider: string,
	config?: ApiConfig["review"],
) => {
	const eligibility = getReviewProviderEligibility(provider);
	const reasons = [
		...eligibility.reasons,
		...(!config?.templateId ? ["review-image-artifact-required"] : []),
		...(!config?.checkTemplateId
			? ["review-check-image-artifact-required"]
			: []),
		...(!config?.enabled ? ["review-release-disabled"] : []),
		...(!config?.stagingVerified ? ["review-staging-evidence-required"] : []),
	];
	return { provider, available: reasons.length === 0, reasons };
};
