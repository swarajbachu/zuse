import {
	GitPrComment,
	GitPrReview,
	type GitPrReviewState,
} from "@zuse/contracts";

type Feedback = {
	body?: string;
	html_url?: string;
	user?: { login?: string; avatar_url?: string } | null;
	created_at?: string;
	submitted_at?: string | null;
	state?: string;
	path?: string;
	line?: number | null;
	original_line?: number | null;
	diff_hunk?: string;
};

// `gh api --paginate --slurp` returns an array of pages. A failed fetch is
// distinct from an empty collection so callers can keep existing feedback.
export const parseFeedbackPages = (stdout: string): Feedback[] | null => {
	try {
		const pages: unknown = JSON.parse(stdout);
		if (!Array.isArray(pages) || !pages.every(Array.isArray)) return null;
		return pages
			.flat()
			.filter(
				(item): item is Feedback =>
					item !== null &&
					typeof item === "object" &&
					(typeof item.body === "string" || item.body === undefined),
			);
	} catch {
		return null;
	}
};

const date = (value: string | null | undefined): Date | null => {
	if (!value) return null;
	const result = new Date(value);
	return Number.isNaN(result.getTime()) ? null : result;
};

export const feedbackComments = (items: readonly Feedback[]): GitPrComment[] =>
	items.flatMap((item) => {
		const createdAt = date(item.created_at);
		return createdAt === null
			? []
			: [
					GitPrComment.make({
						author: item.user?.login ?? "",
						authorAvatarUrl: item.user?.avatar_url ?? null,
						url: item.html_url ?? null,
						body: item.body ?? "",
						createdAt,
						path: item.path ?? null,
						line: item.line ?? item.original_line ?? null,
						diffHunk: item.diff_hunk ?? null,
					}),
				];
	});

export const feedbackReviews = (items: readonly Feedback[]): GitPrReview[] =>
	items.map((item) => {
		const raw = item.state?.toLowerCase();
		const state: GitPrReviewState =
			raw === "approved" ||
			raw === "changes_requested" ||
			raw === "dismissed" ||
			raw === "pending"
				? raw
				: "commented";
		return GitPrReview.make({
			author: item.user?.login ?? "",
			authorAvatarUrl: item.user?.avatar_url ?? null,
			url: item.html_url ?? null,
			body: item.body ?? "",
			state,
			submittedAt: date(item.submitted_at),
		});
	});
