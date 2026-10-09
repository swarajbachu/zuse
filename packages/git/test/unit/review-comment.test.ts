import { describe, expect, test } from "vitest";

import {
	buildCreateReviewCommentBody,
	parseReviewIdentity,
} from "../../src/review-comment.ts";

describe("buildCreateReviewCommentBody", () => {
	test("targets the pull-request head and addition side", () => {
		expect(
			buildCreateReviewCommentBody({
				headSha: "abc123",
				path: "src/app.ts",
				line: 9,
				side: "additions",
				body: "Keep this branch.\nIt is clearer.",
			}),
		).toEqual({
			body: "Keep this branch.\nIt is clearer.",
			commit_id: "abc123",
			path: "src/app.ts",
			line: 9,
			side: "RIGHT",
		});
	});

	test("maps deletion comments to the left side", () => {
		const args = buildCreateReviewCommentBody({
			headSha: "abc123",
			path: "src/app.ts",
			line: 3,
			side: "deletions",
			body: "Why remove this?",
		});
		expect(args.side).toBe("LEFT");
	});
});

describe("parseReviewIdentity", () => {
	test("uses the account name and avatar", () => {
		expect(
			parseReviewIdentity(
				JSON.stringify({
					login: "octo",
					name: "Octo Cat",
					avatar_url: "https://avatars.example/octo.png",
				}),
			),
		).toEqual({
			name: "Octo Cat",
			avatarUrl: "https://avatars.example/octo.png",
		});
	});

	test("falls back to the login and rejects malformed responses", () => {
		expect(parseReviewIdentity('{"login":"octo","name":null}')).toEqual({
			name: "octo",
			avatarUrl: null,
		});
		expect(parseReviewIdentity("not-json")).toBeNull();
	});
});
