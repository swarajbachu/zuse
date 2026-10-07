import type { ReviewFixContext } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	reviewCostLabel,
	reviewFixPrompt,
	reviewStateLabel,
} from "../../src/lib/review-presentation.ts";

const location = {
	path: "src/save.ts",
	startLine: 3,
	endLine: 3,
	side: "RIGHT" as const,
};
const context: ReviewFixContext = {
	runId: "run-1",
	repositoryId: 1,
	repositoryFullName: "zuse/example",
	pullNumber: 7,
	snapshot: {
		repositoryId: 1,
		baseRef: "main",
		baseSha: "a".repeat(40),
		headSha: "b".repeat(40),
		mergeBaseSha: "a".repeat(40),
	},
	currentHeadSha: "c".repeat(40),
	findings: ["chosen", "unselected"].map((id) => ({
		id,
		severity: "high",
		title: `Bug ${id}`,
		explanation: `Explanation ${id}`,
		trigger: "Concurrent save",
		consequence: "Lost update",
		location,
		evidence: [{ ...location, quote: "save(value);" }],
	})),
};

describe("review presentation", () => {
	it("preserves zero final settlement instead of displaying the estimate", () => {
		expect(
			reviewCostLabel({ estimatedCostMicros: 2_000_000, settledCostMicros: 0 }),
		).toContain("Settled");
		expect(
			reviewCostLabel({ estimatedCostMicros: 2_000_000, settledCostMicros: 0 }),
		).not.toContain("2.00");
		expect(reviewCostLabel({ estimatedCostMicros: 2_000_000 })).toContain(
			"Estimated",
		);
		expect(reviewCostLabel({})).not.toContain("$0");
	});
	it("distinguishes incomplete from completed reviews", () => {
		expect(reviewStateLabel("partial")).not.toEqual(
			reviewStateLabel("completed"),
		);
	});
	it("carries only selected evidence and explicit stale-head provenance into a fix", () => {
		const prompt = reviewFixPrompt(context, ["chosen"]);
		expect(prompt).toContain("Bug chosen");
		expect(prompt).not.toContain("unselected");
		expect(prompt).toContain(context.snapshot.headSha);
		expect(prompt).toContain(context.currentHeadSha);
		expect(prompt).toContain("untrusted repository content");
		expect(prompt).toContain("verify the destination repository");
	});
	it("rejects missing or forged selections rather than attaching arbitrary findings", () => {
		expect(() => reviewFixPrompt(context, [])).toThrow();
		expect(() => reviewFixPrompt(context, ["forged"])).toThrow();
	});
});
