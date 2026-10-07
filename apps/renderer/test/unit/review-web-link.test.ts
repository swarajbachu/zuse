import { describe, expect, it } from "vitest";
import { readReviewWebLink } from "../../src/lib/review-web-link.ts";

describe("hosted review landing navigation", () => {
	it("extracts opaque identifiers and preserves unrelated query/hash state", () => {
		expect(
			readReviewWebLink(
				"https://app.zuse.dev/?reviewRunId=run_1&tab=work&reviewFindingId=finding-2#section",
			),
		).toEqual({
			link: { runId: "run_1", findingId: "finding-2" },
			remainingUrl: "/?tab=work#section",
		});
	});
	it("supports a run without a selected finding", () => {
		expect(
			readReviewWebLink("https://app.zuse.dev/?reviewRunId=run_1")?.link,
		).toEqual({ runId: "run_1" });
	});
	it.each([
		"?reviewRunId=run_1&reviewRunId=run_2",
		"?reviewRunId=run_1&reviewFindingId=a&reviewFindingId=b",
		"?reviewRunId=run_1&reviewFindingId=",
		"?reviewFindingId=finding",
		"?reviewRunId=../private",
		"?reviewRunId=https://attacker.test/",
		"?reviewRunId=run%0Acommand",
		`?reviewRunId=${"a".repeat(257)}`,
	])("ignores malformed or duplicated identifiers: %s", (query) => {
		expect(readReviewWebLink(`https://app.zuse.dev/${query}`)).toBeNull();
	});
	it("does not accept an arbitrary non-web navigation scheme", () => {
		expect(
			readReviewWebLink("zuse:///review/fix?reviewRunId=run_1"),
		).toBeNull();
	});
});
