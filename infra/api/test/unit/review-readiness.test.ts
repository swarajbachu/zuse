import { expect, it } from "vitest";
import {
	getReviewReadiness,
	REVIEW_INFRASTRUCTURE_BLOCKERS,
} from "../../src/review-readiness.ts";

it("keeps production blocked independently of subscription eligibility", () => {
	for (const provider of ["codex", "claude", "unsupported"]) {
		const readiness = getReviewReadiness(provider);
		expect(readiness.available).toBe(false);
		expect(readiness.reasons).toEqual(
			expect.arrayContaining([...REVIEW_INFRASTRUCTURE_BLOCKERS]),
		);
	}
});
