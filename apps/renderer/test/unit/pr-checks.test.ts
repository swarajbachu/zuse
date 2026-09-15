import { GitPrCheckRun } from "@zuse/contracts";
import { expect, test } from "vitest";
import { deriveEnvironmentPrRows } from "../../src/lib/branch-workflow.ts";
import { checkKind } from "../../src/lib/pr-checks.ts";

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
