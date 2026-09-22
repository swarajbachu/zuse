import { describe, expect, test } from "vitest";
import {
	feedbackComments,
	feedbackReviews,
	parseFeedbackPages,
	parseReviewThreads,
} from "../../src/pr-feedback.ts";

describe("GitHub feedback", () => {
	test("keeps bot avatars and inline context across pages", () => {
		const items = parseFeedbackPages(
			JSON.stringify([
				[
					{
						user: {
							login: "reviewer[bot]",
							avatar_url: "https://avatars.githubusercontent.com/in/123",
						},
						body: "<h3>Review</h3>\nKeep this code.",
						created_at: "2026-09-15T00:00:00Z",
						html_url: "https://github.com/o/r/pull/1#discussion_r1",
						path: "src/app.ts",
						line: null,
						original_line: 42,
						diff_hunk: "@@ -1 +1 @@\n+hello",
					},
				],
				[{ body: "Another page", created_at: "2026-09-15T01:00:00Z" }],
			]),
		);
		const comments = feedbackComments(items ?? []);
		expect(comments).toHaveLength(2);
		expect(comments[0]).toMatchObject({
			author: "reviewer[bot]",
			authorAvatarUrl: "https://avatars.githubusercontent.com/in/123",
			path: "src/app.ts",
			line: 42,
			url: "https://github.com/o/r/pull/1#discussion_r1",
		});
		expect(comments[0]?.body).toContain("<h3>Review</h3>");
	});
	test("distinguishes empty pages from a failed fetch", () => {
		expect(parseFeedbackPages("[[]]")).toEqual([]);
		expect(parseFeedbackPages("permission denied")).toBeNull();
		expect(parseFeedbackPages('{"message":"Not Found"}')).toBeNull();
	});
	test("handles deleted actors and invalid timestamps", () => {
		expect(feedbackComments([{ user: null, created_at: "bad" }])).toEqual([]);
		expect(
			feedbackReviews([
				{ user: null, state: "CHANGES_REQUESTED", submitted_at: null },
			])[0],
		).toMatchObject({
			author: "",
			authorAvatarUrl: null,
			state: "changes_requested",
			submittedAt: null,
		});
	});
});

const threadPage = (nodes: unknown[], hasNextPage = false) => ({
	data: {
		repository: {
			pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage } } },
		},
	},
});
const thread = (id: number, isResolved: boolean, isOutdated: boolean) => ({
	isResolved,
	isOutdated,
	comments: { nodes: [{ databaseId: id }] },
});

test("thread status spans pages, propagates to replies, and retires inactive review summaries", () => {
	const threads = parseReviewThreads(
		JSON.stringify([
			threadPage([thread(1, true, false)], true),
			threadPage([thread(2, false, true), thread(3, false, false)]),
		]),
	);
	const inline = [
		{ id: 1, pull_request_review_id: 10, created_at: "2026-09-15T00:00:00Z" },
		{
			id: 4,
			in_reply_to_id: 1,
			pull_request_review_id: 10,
			created_at: "2026-09-15T00:00:00Z",
		},
		{ id: 2, pull_request_review_id: 10, created_at: "2026-09-15T00:00:00Z" },
		{ id: 3, pull_request_review_id: 11, created_at: "2026-09-15T00:00:00Z" },
	];
	expect(
		feedbackComments(inline, threads).map(({ isResolved, isOutdated }) => [
			isResolved,
			isOutdated,
		]),
	).toEqual([
		[true, false],
		[true, false],
		[false, true],
		[false, false],
	]);
	expect(
		feedbackReviews([{ id: 10 }, { id: 11 }, { id: 12 }], threads, inline).map(
			(review) => review.hasActiveThreads,
		),
	).toEqual([false, true, undefined]);
	expect(
		feedbackReviews([{ id: 10 }], threads, [
			...inline,
			{ id: 99, pull_request_review_id: 10 },
		])[0]?.hasActiveThreads,
	).toBeUndefined();
});

test("unavailable or partial thread status does not discard feedback", () => {
	for (const output of [
		"bad",
		"[]",
		JSON.stringify([threadPage([thread(1, true, false)], true)]),
		JSON.stringify([
			threadPage([thread(1, true, false)]),
			{ errors: [{ message: "failed" }] },
		]),
	]) {
		const threads = parseReviewThreads(output);
		expect(threads.size).toBe(0);
		expect(
			feedbackReviews([{ id: 10 }], threads, [
				{ id: 1, pull_request_review_id: 10 },
			])[0]?.hasActiveThreads,
		).toBeUndefined();
	}
});
