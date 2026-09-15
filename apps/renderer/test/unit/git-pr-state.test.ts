import { GitPrDetails, GitPrInfo } from "@zuse/contracts";
import { expect, test } from "vitest";
import {
	deriveBranchWorkflow,
	deriveEnvironmentPrRows,
} from "../../src/lib/branch-workflow.ts";
import { resolveGitPrState } from "../../src/lib/git-pr-state.ts";

const run = {
	name: "build",
	status: "completed" as const,
	conclusion: "success" as const,
	url: "https://github.com/acme/app/actions/runs/1",
};
const pr = GitPrInfo.make({
	state: "open",
	branch: "feature",
	baseBranch: "main",
	number: 1,
	url: "https://github.com/acme/app/pull/1",
	isDraft: false,
	checks: "pending",
	checksTotal: 2,
	checksRunning: 2,
	checksPassing: 0,
	checksFailing: 0,
	autoMergeEnabled: false,
	mergeable: "clean",
	additions: 0,
	deletions: 0,
});
const details = GitPrDetails.make({
	...pr,
	headBranch: "feature",
	baseBranch: "main",
	headSha: "head",
	title: "Example",
	body: "",
	author: "user",
	files: [],
	comments: [],
	reviews: [],
	checkRuns: [run],
});
test("legacy summary counters and detailed results resolve identically for header and sidebar", () => {
	const state = resolveGitPrState(pr, details, "feature");
	expect(
		deriveBranchWorkflow(
			{ branch: "feature", dirtyFiles: 0, ahead: 0 },
			state.pr,
			true,
		),
	).toMatchObject({ kind: "open-pr", checks: "success", checksRunning: 0 });
	expect(deriveEnvironmentPrRows(state.pr).checks?.kind).toBe("success");
	expect(state.details?.checks).toBe("success");
});
test("a fresh core check snapshot wins over older details while retaining app metadata", () => {
	const pending = { ...run, status: "in_progress" as const, conclusion: null };
	const state = resolveGitPrState(
		{ ...pr, checkRuns: [pending] },
		{
			...details,
			checkRuns: [
				{ ...run, appAvatarUrl: "https://avatars.githubusercontent.com/app" },
			],
		},
		"feature",
	);
	expect(state.pr?.checksRunning).toBe(1);
	expect(state.details?.checkRuns[0]).toMatchObject({
		...pending,
		appAvatarUrl: "https://avatars.githubusercontent.com/app",
	});
	expect(state.details?.checks).toBe("pending");
});
test("does not borrow checks from another branch or PR", () => {
	expect(
		resolveGitPrState(pr, { ...details, headBranch: "other" }, "feature")
			.checkRuns,
	).toBeNull();
	expect(
		resolveGitPrState(
			pr,
			{ ...details, url: "https://github.com/acme/app/pull/2" },
			"feature",
		).checkRuns,
	).toBeNull();
});

test("enriched checks with decoded dates remain valid when opening the PR", () => {
	const state = resolveGitPrState(
		pr,
		{
			...details,
			checkRuns: [
				{
					...run,
					appName: "GitHub Actions",
					appAvatarUrl: "https://avatars.githubusercontent.com/in/15368",
					startedAt: new Date("2026-09-15T13:53:41Z"),
					completedAt: new Date("2026-09-15T13:56:18Z"),
				},
			],
		},
		"feature",
	);
	expect(() =>
		GitPrInfo.make({ ...pr, checkRuns: state.details?.checkRuns }),
	).not.toThrow();
	expect(state.details?.checkRuns[0]?.completedAt).toEqual(
		new Date("2026-09-15T13:56:18Z"),
	);
});
