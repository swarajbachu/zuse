import { GitPrInfo } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import { prStateLabelFor } from "../../src/lib/pr-branch-state.ts";

const pr = (overrides: Partial<GitPrInfo> = {}) =>
	GitPrInfo.make({
		state: "open",
		branch: "feature",
		baseBranch: "main",
		number: 42,
		url: "https://github.com/acme/app/pull/42",
		isDraft: false,
		checks: "success",
		checksTotal: 1,
		checksRunning: 0,
		checksPassing: 1,
		checksFailing: 0,
		autoMergeEnabled: false,
		mergeable: "clean",
		additions: 0,
		deletions: 0,
		...overrides,
	});

describe("prStateLabelFor", () => {
	it("has no label without a PR", () => {
		expect(prStateLabelFor(null)).toBeNull();
		expect(prStateLabelFor(pr({ state: "none" }))).toBeNull();
	});

	it("names the PR lifecycle state", () => {
		expect(prStateLabelFor(pr())).toBe("Open");
		expect(prStateLabelFor(pr({ isDraft: true }))).toBe("Draft");
		expect(prStateLabelFor(pr({ state: "merged" }))).toBe("Merged");
		expect(prStateLabelFor(pr({ state: "closed" }))).toBe("Closed");
	});

	it("puts conflicts ahead of draft, and leaves checks to the icon", () => {
		expect(
			prStateLabelFor(pr({ mergeable: "conflicting", isDraft: true })),
		).toBe("Conflicts");
		expect(prStateLabelFor(pr({ checks: "failure" }))).toBe("Open");
	});
});
