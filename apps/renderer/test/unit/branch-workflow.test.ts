import { describe, expect, it } from "vitest";

import {
	deriveBranchWorkflow,
	deriveEnvironmentPrRows,
	resolveBranchLabel,
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
	it("shows the persisted worktree branch while the Git snapshot is settling", () => {
		expect(resolveBranchLabel(null, "feature/worktree", null)).toEqual({
			label: "feature/worktree",
			cached: true,
		});
		expect(
			resolveBranchLabel("feature/live", "feature/worktree", null),
		).toEqual({
			label: "feature/live",
			cached: false,
		});
	});

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
	it("ranks conflicts ahead of failing checks for the row action", () => {
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
			action: "resolve",
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

	it.each([
		["a draft", { ...openPr, isDraft: true }, "ready"],
		[
			"a draft with conflicts",
			{ ...openPr, isDraft: true, mergeable: "conflicting" as const },
			"resolve",
		],
		[
			"failing checks",
			{ ...openPr, checks: "failure" as const, checksFailing: 1 },
			"fix",
		],
		[
			"running checks",
			{ ...openPr, checks: "pending" as const, checksRunning: 1 },
			null,
		],
		[
			"an unknown merge state",
			{ ...openPr, mergeable: "unknown" as const },
			null,
		],
		["a clean branch with passing checks", openPr, "merge"],
		["a merged PR", { ...openPr, state: "merged" }, null],
	])("offers one row action for %s", (_name, pr, action) => {
		expect(deriveEnvironmentPrRows(pr).action).toBe(action);
	});
});
