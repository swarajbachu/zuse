import type { SelectedLineRange } from "@pierre/diffs";

export type ReviewAnnotationAnchor = {
	readonly side: "additions" | "deletions";
	readonly lineNumber: number;
};

/** Anchor an annotation to the endpoint where the gutter interaction finished. */
export const getReviewAnnotationAnchor = (
	range: SelectedLineRange,
): ReviewAnnotationAnchor | null => {
	const side = range.endSide ?? range.side;
	if (side === null || side === undefined) return null;
	return { side, lineNumber: range.end };
};
