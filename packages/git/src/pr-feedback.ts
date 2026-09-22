import {
	GitPrComment,
	GitPrReview,
	type GitPrReviewState,
} from "@zuse/contracts";

type Feedback = {
	id?: number;
	in_reply_to_id?: number;
	pull_request_review_id?: number;
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

export const feedbackComments = (
	items: readonly Feedback[],
	threads: ReviewThreads = new Map(),
): GitPrComment[] =>
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
						...threads.get(item.in_reply_to_id ?? item.id ?? -1),
					}),
				];
	});

export const feedbackReviews = (
	items: readonly Feedback[],
	threads: ReviewThreads = new Map(),
	inline: readonly Feedback[] = [],
): GitPrReview[] =>
	items.map((item) => {
		const raw = item.state?.toLowerCase();
		const state: GitPrReviewState =
			raw === "approved" ||
			raw === "changes_requested" ||
			raw === "dismissed" ||
			raw === "pending"
				? raw
				: "commented";
		const comments = inline.filter(
			(comment) =>
				item.id !== undefined && comment.pull_request_review_id === item.id,
		);
		const statuses = comments.map((comment) =>
			threads.get(comment.in_reply_to_id ?? comment.id ?? -1),
		);
		const hasActiveThreads =
			statuses.length > 0 && statuses.every((status) => status !== undefined)
				? statuses.some(
						(status) => status && !status.isResolved && !status.isOutdated,
					)
				: undefined;
		return GitPrReview.make({
			hasActiveThreads,
			author: item.user?.login ?? "",
			authorAvatarUrl: item.user?.avatar_url ?? null,
			url: item.html_url ?? null,
			body: item.body ?? "",
			state,
			submittedAt: date(item.submitted_at),
		});
	});

// Fetch only each thread's root; REST replies point to it via in_reply_to_id.
// This avoids truncating long conversations and paginates all review threads.
export const PR_REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
 repository(owner: $owner, name: $repo) {
  pullRequest(number: $number) {
   reviewThreads(first: 100, after: $endCursor) {
    pageInfo { hasNextPage endCursor }
    nodes { isResolved isOutdated comments(first: 1) { nodes { databaseId } } }
   }
  }
 }
}`;

type ThreadStatus = { isResolved: boolean; isOutdated: boolean };
type ReviewThreads = ReadonlyMap<number, ThreadStatus>;

export function parseReviewThreads(stdout: string): ReviewThreads {
	const result = new Map<number, ThreadStatus>();
	try {
		const pages = JSON.parse(stdout);
		if (!Array.isArray(pages)) return result;
		for (const page of pages) {
			const connection = page?.data?.repository?.pullRequest?.reviewThreads;
			// A partial response must not classify an incomplete review as resolved.
			if (page.errors?.length || !Array.isArray(connection?.nodes))
				return new Map();
			for (const thread of connection.nodes) {
				const id = thread?.comments?.nodes?.[0]?.databaseId;
				if (
					typeof id !== "number" ||
					typeof thread.isResolved !== "boolean" ||
					typeof thread.isOutdated !== "boolean"
				)
					return new Map();
				result.set(id, {
					isResolved: thread.isResolved,
					isOutdated: thread.isOutdated,
				});
			}
		}
		if (
			pages.at(-1)?.data?.repository?.pullRequest?.reviewThreads?.pageInfo
				?.hasNextPage !== false
		)
			return new Map();
		return result;
	} catch {
		return new Map();
	}
}
