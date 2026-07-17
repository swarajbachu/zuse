import type { UnresolvedFile as UnresolvedFileInstance } from "@pierre/diffs";
import { describe, expect, test, vi } from "vitest";
import {
	applyReviewConflictResolution,
	reviewFingerprint,
} from "./changes-review.tsx";

describe("reviewFingerprint", () => {
	test("stays stable for the same rendered patch", () => {
		const patch = "@@ -1 +1 @@\n-old\n+new\n";
		expect(reviewFingerprint(patch)).toBe(reviewFingerprint(patch));
	});

	test("changes when the rendered patch changes", () => {
		expect(reviewFingerprint("+first\n")).not.toBe(
			reviewFingerprint("+second\n"),
		);
	});
});

describe("applyReviewConflictResolution", () => {
	test("updates controlled conflict state without a partial manual render", () => {
		const resolution = {
			file: { name: "conflicted.ts", contents: "resolved\n" },
			fileDiff: { hunks: [] },
			actions: [],
			markerRows: [],
		};
		const dispatch = vi.fn();
		const instance = {
			resolveConflict: vi.fn(() => resolution),
			options: { onMergeConflictAction: dispatch },
			render: vi.fn((props: Record<string, unknown>) => {
				if (
					!("fileDiff" in props) ||
					!("actions" in props) ||
					!("markerRows" in props)
				) {
					throw new Error(
						"fileDiff, actions, and markerRows must be passed together",
					);
				}
			}),
		} as unknown as UnresolvedFileInstance<undefined>;

		expect(() =>
			applyReviewConflictResolution(
				instance,
				0,
				{ conflictIndex: 0 } as never,
				"incoming",
			),
		).not.toThrow();
		expect(dispatch).toHaveBeenCalledOnce();
		expect(instance.render).toHaveBeenCalledWith({
			fileDiff: resolution.fileDiff,
			actions: resolution.actions,
			markerRows: resolution.markerRows,
		});
	});
});
