import { describe, expect, test } from "vitest";

import { branchStatePresentation } from "../../../src/lib/pr-state-presentation";

const base = {
	state: "open",
	branch: "feature",
	baseBranch: "main",
	additions: 0,
	deletions: 0,
	number: 12,
	url: null,
	isDraft: false,
	checks: "success",
	mergeable: "clean",
	checksTotal: 1,
	checksRunning: 0,
	checksPassing: 1,
	checksFailing: 0,
	autoMergeEnabled: false,
} as const;

describe("PR state presentation", () => {
	test("prioritizes states that need action", () => {
		expect(
			branchStatePresentation({ ...base, mergeable: "conflicting" }),
		).toEqual({ label: "Needs resolve", tone: "danger", icon: "warning" });
		expect(branchStatePresentation({ ...base, checks: "failure" })).toEqual({
			label: "Checks failed",
			tone: "danger",
			icon: "warning",
		});
	});

	test("shows plain branch lifecycle states", () => {
		expect(branchStatePresentation(base)).toEqual({
			label: "Open",
			tone: "brand",
			icon: "pull-request",
		});
		expect(branchStatePresentation({ ...base, state: "merged" })).toEqual({
			label: "Merged",
			tone: "success",
			icon: "merged",
		});
		expect(branchStatePresentation({ ...base, state: "none" })).toBeNull();
	});
});
