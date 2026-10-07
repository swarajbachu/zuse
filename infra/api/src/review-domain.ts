import type {
	ReviewEnrollment,
	ReviewRun,
	ReviewRunState,
} from "@zuse/contracts";
/** Durable review policy. No provider credentials or repository contents belong here. */
export type ReviewState = ReviewRunState;
export interface ReviewEnrollmentRecord
	extends Omit<ReviewEnrollment, "githubUserId"> {
	githubUserId: number | null;
	enabledBy: string;
}
export interface ReviewComparison {
	repositoryId: number;
	repositoryFullName: string;
	installationId: number;
	pullNumber: number;
	authorGithubUserId: number;
	baseRef: string;
	baseSha: string;
	headSha: string;
	fork: boolean;
}
export interface ReviewRunRecord
	extends Omit<ReviewRun, "mergeBaseSha" | "blockedReason"> {
	installationId: number;
	authorGithubUserId: number;
	fork: boolean;
	mergeBaseSha: string | null;
	configVersion: string;
	generation: string;
	blockedReason: string | null;
}
export const REVIEW_POLICY = Object.freeze({
	configVersion: "review-v1",
	debounceMs: 30_000,
	maxDebounceMs: 120_000,
	maxAllocatedMs: 600_000,
	maxAttempts: 2,
	maxInlineFindings: 5,
});
/** Match before checking readiness: a broken personal enrollment never spends shared funds. */
export const selectReviewEnrollment = (
	enrollments: readonly ReviewEnrollmentRecord[],
	authorGithubUserId: number,
): ReviewEnrollmentRecord | null => {
	const enabled = enrollments.filter((item) => item.enabled);
	const personal = enabled.filter(
		(item) =>
			item.kind === "personal" && item.githubUserId === authorGithubUserId,
	);
	const shared = enabled.filter((item) => item.kind === "shared");
	if (personal.length > 1 || shared.length > 1)
		throw new Error("review_ambiguous_enrollment");
	return personal[0] ?? shared[0] ?? null;
};
/** Payer changes do not create duplicate automatic reviews. Explicit reruns use a fresh generation. */
export const reviewComparisonKey = (
	comparison: ReviewComparison,
	configVersion: string,
	generation = "automatic",
) =>
	JSON.stringify([
		comparison.repositoryId,
		comparison.pullNumber,
		comparison.baseRef,
		comparison.baseSha,
		comparison.headSha,
		configVersion,
		generation,
	]);
export const reviewTerminal = (state: ReviewState) =>
	state === "completed" ||
	state === "partial" ||
	state === "failed" ||
	state === "cancelled" ||
	state === "superseded";
export const reviewMarker = (runId: string, publicationId: string) => {
	if (
		!/^[a-zA-Z0-9_-]+$/.test(runId) ||
		!/^[a-zA-Z0-9_-]+$/.test(publicationId)
	)
		throw new Error("invalid_review_marker");
	return `<!-- zuse-review:${runId}:${publicationId} -->`;
};

export const shouldAutomaticallyReviewPull = (input: {
	draft?: boolean;
	authorType?: string;
}) => input.draft !== true && input.authorType === "User";
