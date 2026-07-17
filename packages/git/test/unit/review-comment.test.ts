import { describe, expect, test } from "vitest";

import {
	buildCreateReviewCommentArgs,
	parseReviewIdentity,
} from "../../src/review-comment.ts";

describe("buildCreateReviewCommentArgs", () => {
	test("targets the pull-request head and addition side", () => {
		expect(
			buildCreateReviewCommentArgs({
				owner: "octo",
				repo: "project",
				pullNumber: 42,
				headSha: "abc123",
				path: "src/app.ts",
				line: 9,
				side: "additions",
				body: "Keep this branch.\nIt is clearer.",
			}),
		).toEqual([
			"api",
			"--method",
			"POST",
			"repos/octo/project/pulls/42/comments",
			"-f",
			"body=Keep this branch.\nIt is clearer.",
			"-f",
			"commit_id=abc123",
			"-f",
			"path=src/app.ts",
			"-F",
			"line=9",
			"-f",
			"side=RIGHT",
		]);
	});

	test("maps deletion comments to the left side", () => {
		const args = buildCreateReviewCommentArgs({
			owner: "octo",
			repo: "project",
			pullNumber: 42,
			headSha: "abc123",
			path: "src/app.ts",
			line: 3,
			side: "deletions",
			body: "Why remove this?",
		});
		expect(args.at(-1)).toBe("side=LEFT");
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
