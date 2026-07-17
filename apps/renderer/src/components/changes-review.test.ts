import type {
	MergeConflictRegion,
	UnresolvedFile as UnresolvedFileInstance,
} from "@pierre/diffs";
import { describe, expect, test, vi } from "vitest";
import {
	applyReviewConflictResolution,
	resolveReviewConflictContents,
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
	test("dispatches exactly one controlled conflict action", () => {
		const dispatch = vi.fn();
		const instance = {
			resolveConflict: vi.fn(),
			options: { onMergeConflictAction: dispatch },
		} as unknown as UnresolvedFileInstance<undefined>;

		const conflict = { conflictIndex: 0 } as MergeConflictRegion;
		expect(applyReviewConflictResolution(instance, conflict, "incoming")).toBe(
			true,
		);
		expect(dispatch).toHaveBeenCalledWith(
			{ conflict, resolution: "incoming" },
			instance,
		);
		expect(instance.resolveConflict).not.toHaveBeenCalled();
	});
});

describe("resolveReviewConflictContents", () => {
	const source = [
		"export default config;\n",
		"\n",
		"<<<<<<< HEAD\n",
		"// current\n",
		"export const VALUE = 'current';\n",
		"=======\n",
		"// incoming\n",
		"export const VALUE = 'incoming';\n",
		">>>>>>> branch\n",
		"after();\n",
	].join("");
	const conflict: MergeConflictRegion = {
		conflictIndex: 0,
		startLineIndex: 2,
		startLineNumber: 3,
		separatorLineIndex: 5,
		separatorLineNumber: 6,
		endLineIndex: 8,
		endLineNumber: 9,
	};

	test("accepts only the current side and removes every marker", () => {
		const result = resolveReviewConflictContents(source, conflict, "current");
		expect(result).toContain("'current'");
		expect(result).not.toContain("'incoming'");
		expect(result).not.toContain("<<<<<<<");
		expect(result).not.toContain("=======");
		expect(result).not.toContain(">>>>>>>");
	});

	test("accepts only the incoming side and removes every marker", () => {
		const result = resolveReviewConflictContents(source, conflict, "incoming");
		expect(result).toContain("'incoming'");
		expect(result).not.toContain("'current'");
		expect(result).not.toContain("<<<<<<<");
		expect(result).not.toContain("=======");
		expect(result).not.toContain(">>>>>>>");
	});

	test("accepts both sides without retaining markers", () => {
		const result = resolveReviewConflictContents(source, conflict, "both");
		expect(result).toContain("'current'");
		expect(result).toContain("'incoming'");
		expect(result).not.toContain("<<<<<<<");
		expect(result).not.toContain(">>>>>>>");
	});
});
