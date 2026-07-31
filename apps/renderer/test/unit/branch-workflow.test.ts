import { describe, expect, it } from "vitest";

import {
	deriveBranchWorkflow,
	deriveEnvironmentPrRows,
} from "../../src/lib/branch-workflow.ts";

const cleanStatus = { branch: "feature", dirtyFiles: 0, ahead: 0 };
const openPr = {
	state: "open",
	number: 42,
	url: "https://example.test/pull/42",
	isDraft: false,
	checks: "success" as const,
	mergeable: "clean" as const,
	checksTotal: 3,
	checksRunning: 0,
	checksPassing: 3,
	checksFailing: 0,
	autoMergeEnabled: false,
};

describe("branch workflow", () => {
	it("keeps the primary action independent from PR health rows", () => {
		const workflow = deriveBranchWorkflow(
			cleanStatus,
			{
				...openPr,
				checks: "failure",
				mergeable: "conflicting",
				checksPassing: 1,
				checksFailing: 2,
			},
			true,
		);

		expect(workflow).toMatchObject({
			kind: "open-pr",
			checks: "failure",
			mergeable: "conflicting",
		});
	});
});

describe("environment PR rows", () => {
	it("shows checks and conflicts as separate simultaneous rows", () => {
		const rows = deriveEnvironmentPrRows({
			...openPr,
			checks: "failure",
			mergeable: "conflicting",
			checksPassing: 1,
			checksFailing: 2,
		});

		expect(rows).toEqual({
			checks: {
				kind: "failure",
				label: "2 checks failing",
				canFix: true,
			},
			conflicts: true,
		});
	});

	it("keeps failed checks actionable while other checks are still running", () => {
		const rows = deriveEnvironmentPrRows({
			...openPr,
			checks: "failure",
			checksRunning: 1,
			checksPassing: 1,
			checksFailing: 1,
		});

		expect(rows.checks).toEqual({
			kind: "failure",
			label: "1 check failing",
			canFix: true,
		});
	});

	it.each([
		[{ ...openPr, checksTotal: 0, checksPassing: 0 }, null],
		[
			{
				...openPr,
				checks: "pending" as const,
				checksRunning: 2,
				checksPassing: 1,
			},
			{ kind: "pending", label: "2 checks running", canFix: false },
		],
		[openPr, { kind: "success", label: "Checks passed", canFix: false }],
	])("derives the checks row from PR check counts", (pr, checks) => {
		expect(deriveEnvironmentPrRows(pr).checks).toEqual(checks);
	});
});
