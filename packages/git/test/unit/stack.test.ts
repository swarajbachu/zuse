import { expect, test } from "vitest";
import {
	parseStackView,
	stackPullRequestsQuery,
	withStackPullRequests,
} from "../../src/stack.ts";

test("reads gh-stack branches without depending on PR-only metadata", () => {
	expect(
		parseStackView(
			JSON.stringify({
				trunk: "main",
				currentBranch: "feature",
				branches: [
					{ name: "foundation", isMerged: true },
					{ name: "feature", isCurrent: true, needsRebase: true },
				],
			}),
		),
	).toMatchObject({
		trunk: "main",
		branches: [
			{ name: "foundation", isMerged: true, isCurrent: false },
			{ name: "feature", isCurrent: true, needsRebase: true },
		],
	});
});

test("rejects missing extension and malformed stack data", () => {
	for (const output of [
		"unknown command stack",
		"null",
		"{}",
		'{"trunk":"main","branches":[null]}',
	])
		expect(parseStackView(output)).toBeNull();
});

test("rejects malformed present status flags but accepts omitted flags", () => {
	for (const flag of ["isCurrent", "isMerged", "needsRebase"]) {
		for (const value of ["true", 0, 1, null, {}, []]) {
			expect(
				parseStackView(
					JSON.stringify({
						trunk: "main",
						branches: [{ name: "feature", [flag]: value }],
					}),
				),
			).toBeNull();
		}
	}
	expect(
		parseStackView('{"trunk":"main","branches":[{"name":"feature"}]}')
			?.branches[0],
	).toMatchObject({ isCurrent: false, isMerged: false, needsRebase: false });
});

test("preserves PR references without mistaking gh-stack OPEN for ready for review", () => {
	const stack = parseStackView(
		JSON.stringify({
			trunk: "main",
			branches: [
				{
					name: "feature",
					pr: {
						number: 12,
						url: "https://github.com/o/r/pull/12",
						state: "OPEN",
					},
				},
			],
		}),
	);
	expect(stack?.branches[0]?.pr).toEqual({
		number: 12,
		url: "https://github.com/o/r/pull/12",
		state: "unknown",
		isDraft: null,
	});
});

test("batches PR status lookup and preserves branches if metadata is unavailable", () => {
	const stack = parseStackView(
		JSON.stringify({
			trunk: "main",
			branches: [
				{ name: "draft", pr: { number: 12 } },
				{ name: "open", pr: { number: 13 } },
				{ name: "merged", pr: { number: 14 } },
				{ name: "closed", pr: { number: 15 } },
				{ name: "local" },
			],
		}),
	);
	if (!stack) throw new Error("Expected valid stack fixture");
	expect(stackPullRequestsQuery(stack, "owner", "repo")).toContain(
		"pr12: pullRequest(number: 12) { number title state isDraft }",
	);
	expect(stackPullRequestsQuery(stack, "owner", "repo")).toContain(
		"pr15: pullRequest(number: 15)",
	);
	const enriched = withStackPullRequests(
		stack,
		JSON.stringify({
			data: {
				repository: {
					pr12: {
						number: 12,
						title: "Draft title",
						state: "OPEN",
						isDraft: true,
					},
					pr13: {
						number: 13,
						title: "Open title",
						state: "OPEN",
						isDraft: false,
					},
					pr14: {
						number: 14,
						title: "Merged title",
						state: "MERGED",
						isDraft: false,
					},
					pr15: {
						number: 15,
						title: "Closed title",
						state: "CLOSED",
						isDraft: false,
					},
				},
			},
		}),
	);
	expect(
		enriched.branches.map(
			(b) => b.pr && [b.pr.title, b.pr.state, b.pr.isDraft],
		),
	).toEqual([
		["Draft title", "open", true],
		["Open title", "open", false],
		["Merged title", "merged", false],
		["Closed title", "closed", false],
		undefined,
	]);
	expect(enriched.branches[2]?.isMerged).toBe(true);
	for (const response of [
		"",
		"not JSON",
		'{"data":{"repository":null}}',
		'{"data":{"repository":{"pr12":{"number":99}}}}',
	])
		expect(withStackPullRequests(stack, response)).toEqual(stack);
	expect(
		stackPullRequestsQuery({ ...stack, branches: [] }, "o", "r"),
	).toBeNull();
});
