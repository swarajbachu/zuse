import { expect, it } from "vitest";
import {
	evaluateReviewRelease,
	type ReviewEvaluationCase,
	validateEvaluationCorpus,
} from "../../src/index.ts";

const fixture: ReviewEvaluationCase = {
	id: "example",
	repository: "example/test",
	headSha: "a".repeat(40),
	split: "held-out",
	label: "defect",
	provenance: "synthetic",
	adjudicator: "",
	highSeverityDefects: 1,
};
it("blocks launch on absent or synthetic corpus instead of reporting zero false positives", () => {
	const result = evaluateReviewRelease([], []);
	expect(result.passed).toBe(false);
	expect(result.metrics.precision).toBeNull();
	expect(result.metrics.uncertainty.precision).toBeNull();
	expect(validateEvaluationCorpus([fixture])).toContain(
		"Missing human adjudication: example",
	);
});
it("rejects repository leakage and missing observations", () => {
	expect(
		validateEvaluationCorpus([
			fixture,
			{ ...fixture, id: "dev", split: "development" },
		]),
	).toContain("Repository leaks across splits: example/test");
	expect(evaluateReviewRelease([fixture], []).errors).toContain(
		"Missing observation: example",
	);
});
it("computes precision and recall separately and refuses incomplete reviews", () => {
	const result = evaluateReviewRelease(
		[
			{
				...fixture,
				provenance: "human-adjudicated",
				adjudicator: "fixture-labeler",
			},
			{ ...fixture, id: "clean", label: "clean", highSeverityDefects: 0 },
		],
		[
			{
				caseId: "example",
				published: 2,
				truePositives: 1,
				highSeverityFound: 1,
				completed: false,
				durationMs: 100,
				settledComputeMicros: 20,
			},
			{
				caseId: "clean",
				published: 1,
				truePositives: 0,
				highSeverityFound: 0,
				completed: true,
				durationMs: 200,
				settledComputeMicros: 30,
			},
		],
	);
	expect(result.metrics.precision).toBeCloseTo(1 / 3);
	expect(result.metrics.highSeverityRecall).toBe(1);
	expect(result.metrics.cleanPrFalsePositiveRate).toBe(1);
	expect(result.metrics.totalSettledComputeMicros).toBe(50);
	expect(result.metrics.uncertainty.precision?.trials).toBe(3);
	expect(result.metrics.uncertainty.precision?.successes).toBe(1);
	expect(result.metrics.uncertainty.precision?.lower).toBeCloseTo(0.06149, 4);
	expect(result.metrics.uncertainty.precision?.upper).toBeCloseTo(0.79234, 4);
	expect(result.metrics.uncertainty.highSeverityRecall?.lower).toBeLessThan(
		0.3,
	);
	expect(result.metrics.uncertainty.highSeverityRecall?.upper).toBe(1);
	expect(result.passed).toBe(false);
});
