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

export const getReviewItemVersion = ({
	collapsed,
	editing,
	annotationKey,
}: {
	readonly collapsed: boolean;
	readonly editing: boolean;
	readonly annotationKey: string;
}): number => {
	const stateKey = `${Number(collapsed)}:${Number(editing)}:${annotationKey}`;
	let value = 2166136261;
	for (let index = 0; index < stateKey.length; index += 1) {
		value ^= stateKey.charCodeAt(index);
		value = Math.imul(value, 16777619);
	}
	return value >>> 0;
};
