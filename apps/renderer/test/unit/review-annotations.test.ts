import { describe, expect, test } from "vitest";

import {
	getReviewAnnotationAnchor,
	getReviewItemVersion,
} from "../../src/lib/review-annotations.ts";

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

describe("getReviewItemVersion", () => {
	test("publishes a new controlled-item version when annotations change", () => {
		const withoutAnnotation = getReviewItemVersion({
			collapsed: false,
			editing: false,
			annotationKey: "",
		});
		const withDraft = getReviewItemVersion({
			collapsed: false,
			editing: false,
			annotationKey: "draft:additions:16",
		});

		expect(withDraft).not.toBe(withoutAnnotation);
	});
});
