import type { GitPrComment, GitPrReview } from "@zuse/contracts";

export function feedbackDestination(
	feedback:
		| Pick<GitPrReview, "url">
		| Pick<GitPrComment, "url" | "path" | "line">,
) {
	if ("path" in feedback && feedback.path) {
		return {
			kind: "file" as const,
			path: feedback.path,
			line: feedback.line ?? undefined,
		};
	}
	return feedback.url ? { kind: "thread" as const, url: feedback.url } : null;
}
