import { GitDiffResult, GitReviewPatch } from "@zuse/contracts";
import { describe, expect, test } from "vitest";

import { prepareReviewPatch } from "../../../src/lib/review-diff-model";

describe("prepared review diffs", () => {
	test("keeps parsed lines without retaining the raw patch", () => {
		const prepared = prepareReviewPatch(
			GitReviewPatch.make({
				path: "src/index.ts",
				error: null,
				result: GitDiffResult.make({
					mode: "worktree",
					patch: "@@ -1,1 +1,1 @@\n-old\n+new",
					truncated: false,
					bytes: 31,
				}),
			}),
		);

		expect(prepared.lines.map((line) => line.kind)).toEqual([
			"hunk",
			"removed",
			"added",
		]);
		expect("patch" in prepared).toBe(false);
	});

	test("does not parse binary patches", () => {
		const prepared = prepareReviewPatch(
			GitReviewPatch.make({
				path: "image.png",
				error: null,
				result: GitDiffResult.make({
					mode: "binary",
					patch: "ignored",
					truncated: false,
					bytes: 7,
				}),
			}),
		);

		expect(prepared.lines).toEqual([]);
	});
});
