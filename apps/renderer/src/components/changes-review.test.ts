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
		let initializedFile = false;
		const instance = {
			resolveConflict: vi.fn(() =>
				initializedFile
					? resolution
					: {
							...resolution,
							file: { ...resolution.file, contents: "" },
						},
			),
			options: { onMergeConflictAction: dispatch },
			render: vi.fn((props: Record<string, unknown>) => {
				if ("file" in props && !("fileDiff" in props)) {
					initializedFile = true;
					return;
				}
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

		let resolvedContents: string | undefined;
		expect(() => {
			resolvedContents = applyReviewConflictResolution(
				instance,
				{ name: "conflicted.ts", contents: "full conflicted file\n" },
				0,
				{ conflictIndex: 0 } as never,
				"incoming",
			)?.file.contents;
		}).not.toThrow();
		expect(resolvedContents).toBe("resolved\n");
		expect(dispatch).toHaveBeenCalledOnce();
		expect(instance.render).toHaveBeenCalledWith({
			file: resolution.file,
			fileDiff: resolution.fileDiff,
			actions: resolution.actions,
			markerRows: resolution.markerRows,
		});
	});
});
