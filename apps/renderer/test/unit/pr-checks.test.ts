import { GitPrCheckRun } from "@zuse/contracts";
import { expect, test } from "vitest";
import { deriveEnvironmentPrRows } from "../../src/lib/branch-workflow.ts";
import { checkKind, countChecks, sortChecks } from "../../src/lib/pr-checks.ts";

const passed = GitPrCheckRun.make({
	name: "build",
	status: "completed",
	conclusion: "success",
	url: null,
});
test("completed checks override stale running counters in the summary", () => {
	expect(
		deriveEnvironmentPrRows({
			state: "open",
			number: 1,
			url: null,
			checks: "pending",
			checksTotal: 1,
			checksRunning: 1,
			checkRuns: [passed],
		}).checks,
	).toMatchObject({ kind: "success", label: "Checks passed" });
});
test("a terminal conclusion never renders as running", () => {
	expect(checkKind({ ...passed, status: "in_progress" })).toBe("success");
	expect(
		checkKind({ ...passed, status: "queued", conclusion: "failure" }),
	).toBe("failure");
	expect(
		checkKind({ ...passed, status: "in_progress", conclusion: null }),
	).toBe("pending");
});

test("checks sort by attention and count by kind", () => {
	const failed = { ...passed, name: "lint", conclusion: "failure" as const };
	const running = {
		...passed,
		name: "e2e",
		status: "in_progress" as const,
		conclusion: null,
	};
	const skipped = { ...passed, name: "deploy", conclusion: "skipped" as const };
	const checks = [skipped, passed, running, failed];
	expect(sortChecks(checks).map((check) => check.name)).toEqual([
		"lint",
		"e2e",
		"build",
		"deploy",
	]);
	expect(countChecks(checks)).toEqual({
		failure: 1,
		pending: 1,
		success: 1,
		neutral: 1,
		total: 4,
	});
});
