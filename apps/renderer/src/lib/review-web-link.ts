import {
	buildReviewFixLink,
	parseReviewFixLink,
	type ReviewFixLink,
} from "@zuse/client-runtime/review-links";

/** Extract an opaque navigation hint while preserving unrelated browser state. */
export function readReviewWebLink(
	value: string,
): { link: ReviewFixLink; remainingUrl: string } | null {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		const runs = url.searchParams.getAll("reviewRunId");
		const findings = url.searchParams.getAll("reviewFindingId");
		if (runs.length !== 1 || findings.length > 1) return null;
		const runId = runs[0];
		if (!runId) return null;
		const link = parseReviewFixLink(
			buildReviewFixLink({
				runId,
				...(findings[0] !== undefined ? { findingId: findings[0] } : {}),
			}),
		);
		if (!link) return null;
		url.searchParams.delete("reviewRunId");
		url.searchParams.delete("reviewFindingId");
		return { link, remainingUrl: `${url.pathname}${url.search}${url.hash}` };
	} catch {
		return null;
	}
}
