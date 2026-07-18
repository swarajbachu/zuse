import { describe, expect, test } from "vitest";

import { buildLastTurnReview } from "../../../src/lib/last-turn-review";

describe("last turn review", () => {
	test("combines recorded tool edits by file", () => {
		const review = buildLastTurnReview({
			body: [
				{
					content: {
						_tag: "tool_use",
						tool: "Edit",
						input: {
							path: "src/index.ts",
							old_string: "const value = 1;",
							new_string: "const value = 2;",
						},
					},
				},
			] as never,
		} as never);

		expect(review.summary.files).toHaveLength(1);
		expect(review.summary.files[0]).toMatchObject({
			path: "src/index.ts",
			additions: 1,
			deletions: 1,
		});
		expect(review.patches["src/index.ts"]?.lines).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "removed" }),
				expect.objectContaining({ kind: "added" }),
			]),
		);
	});
});
