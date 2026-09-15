import { expect, test } from "vitest";
import { parseStackView } from "../../src/stack.ts";

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
