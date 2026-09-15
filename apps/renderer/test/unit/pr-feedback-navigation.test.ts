import { expect, test } from "vitest";
import { feedbackDestination } from "../../src/lib/pr-feedback-navigation.ts";

test("inline feedback opens its exact file and line instead of the whole thread", () => {
	expect(
		feedbackDestination({
			path: "src/checks.ts",
			line: 42,
			url: "https://github.com/acme/app/pull/1#discussion_r2",
		}),
	).toEqual({ kind: "file", path: "src/checks.ts", line: 42 });
});
test("PR-wide summaries open their original thread, and missing destinations stay inactive", () => {
	expect(
		feedbackDestination({
			url: "https://github.com/acme/app/pull/1#issuecomment-2",
		}),
	).toEqual({
		kind: "thread",
		url: "https://github.com/acme/app/pull/1#issuecomment-2",
	});
	expect(feedbackDestination({ path: null, line: null, url: null })).toBeNull();
	expect(
		feedbackDestination({ path: "src/checks.ts", line: null, url: null }),
	).toEqual({ kind: "file", path: "src/checks.ts", line: undefined });
});
