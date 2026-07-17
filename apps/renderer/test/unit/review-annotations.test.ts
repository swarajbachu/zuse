import { describe, expect, test } from "vitest";

import { getReviewAnnotationAnchor } from "../../src/lib/review-annotations.ts";

describe("getReviewAnnotationAnchor", () => {
	test("anchors to the endpoint for a forward selection", () => {
		expect(
			getReviewAnnotationAnchor({
				start: 4,
				end: 9,
				side: "additions",
				endSide: "additions",
			}),
		).toEqual({ side: "additions", lineNumber: 9 });
	});

	test("keeps the endpoint side for a cross-side selection", () => {
		expect(
			getReviewAnnotationAnchor({
				start: 12,
				end: 7,
				side: "deletions",
				endSide: "additions",
			}),
		).toEqual({ side: "additions", lineNumber: 7 });
	});

	test("rejects ranges without a diff side", () => {
		expect(getReviewAnnotationAnchor({ start: 2, end: 2 })).toBeNull();
	});
});
