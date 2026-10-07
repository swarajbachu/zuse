import { describe, expect, it } from "vitest";
import {
	type ReviewComparison,
	type ReviewEnrollmentRecord,
	reviewComparisonKey,
	reviewMarker,
	selectReviewEnrollment,
	shouldAutomaticallyReviewPull,
} from "../../src/review-domain.ts";

const shared: ReviewEnrollmentRecord = {
	id: "shared",
	repositoryId: 1,
	repositoryFullName: "org/repo",
	installationId: 2,
	kind: "shared",
	githubUserId: null,
	ownerId: "shared-payer",
	enabledBy: "admin",
	modelConnectionId: "connection",
	agentProvider: "codex",
	model: "model",
	worker: { provider: "e2b", size: "small", maxRuntimeMs: 600000 },
	enabled: true,
	version: 1,
	createdAtMs: 0,
	updatedAtMs: 0,
};
const personal: ReviewEnrollmentRecord = {
	...shared,
	id: "personal",
	kind: "personal",
	githubUserId: 42,
	ownerId: "author-payer",
};
const comparison: ReviewComparison = {
	repositoryId: 1,
	repositoryFullName: "org/repo",
	installationId: 2,
	pullNumber: 5,
	authorGithubUserId: 42,
	baseRef: "main",
	baseSha: "a".repeat(40),
	headSha: "b".repeat(40),
	fork: false,
};
describe("review routing", () => {
	it("personal author wins independently of order and connection readiness", () => {
		expect(selectReviewEnrollment([shared, personal], 42)).toEqual(personal);
		expect(selectReviewEnrollment([personal, shared], 42)?.ownerId).toBe(
			"author-payer",
		);
		expect(selectReviewEnrollment([personal, shared], 43)?.ownerId).toBe(
			"shared-payer",
		);
	});
	it("does not turn connection or repo access into enrollment", () =>
		expect(selectReviewEnrollment([], 42)).toBeNull());
	it("disabled personal no longer covers future runs", () =>
		expect(
			selectReviewEnrollment([shared, { ...personal, enabled: false }], 42),
		).toEqual(shared));
	it("refuses ambiguous duplicate sponsors", () =>
		expect(() =>
			selectReviewEnrollment([shared, { ...shared, id: "other" }], 42),
		).toThrow("ambiguous"));
	it("includes base and head and manual generation in identity", () => {
		const key = reviewComparisonKey(comparison, "v1");
		for (const c of [
			{ ...comparison, baseSha: "c".repeat(40) },
			{ ...comparison, headSha: "c".repeat(40) },
			{ ...comparison, baseRef: "release" },
		])
			expect(reviewComparisonKey(c, "v1")).not.toBe(key);
		expect(reviewComparisonKey(comparison, "v1", "manual-1")).not.toBe(key);
		expect(
			reviewComparisonKey(
				{ ...comparison, repositoryFullName: "renamed/repo" },
				"v1",
			),
		).toBe(key);
	});
	it("rejects marker injection", () =>
		expect(() => reviewMarker("run-->", "finding")).toThrow());
});

it("only schedules non-draft PRs whose fresh GitHub author is positively human", () => {
	expect(shouldAutomaticallyReviewPull({ authorType: "User" })).toBe(true);
	expect(
		shouldAutomaticallyReviewPull({ authorType: "User", draft: true }),
	).toBe(false);
	expect(shouldAutomaticallyReviewPull({ authorType: "Bot" })).toBe(false);
	expect(shouldAutomaticallyReviewPull({})).toBe(false);
});
