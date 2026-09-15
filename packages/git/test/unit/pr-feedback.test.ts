import { describe, expect, test } from "vitest";
import {
	feedbackComments,
	feedbackReviews,
	parseFeedbackPages,
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
