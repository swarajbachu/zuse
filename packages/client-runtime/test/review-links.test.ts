import { describe, expect, it } from "vitest";
import { buildReviewFixLink, parseReviewFixLink } from "../src/review-links.ts";

describe("review navigation links", () => {
	it("round trips opaque run and finding identifiers", () => {
		const input = { runId: "run-123", findingId: "abc_456" };
		expect(parseReviewFixLink(buildReviewFixLink(input))).toEqual(input);
		expect(
			parseReviewFixLink(buildReviewFixLink({ runId: "run-123" })),
		).toEqual({ runId: "run-123" });
	});
	it.each([
		"https://example.com/review/fix?runId=run-1",
		"zuse://evil/review/fix?runId=run-1",
		"zuse:///review/fix",
		"zuse:///review/fix?runId=run-1&runId=run-2",
		"zuse:///review/fix?runId=run-1&findingId=one&findingId=two",
		"zuse:///review/fix?runId=run-1&findingId=",
		"zuse:///review/fix?runId=run-1&prompt=execute",
		"zuse:///review/fix?runId=run-1&token=secret",
		"zuse:///review/fix?runId=run-1#token=secret",
		"zuse:///review/fix?runId=..%2Fsecrets",
		"zuse:///review/fix?runId=%0Acommand",
		`zuse:///review/fix?runId=${"a".repeat(257)}`,
		"not a URL",
	])("rejects invalid or authority-bearing input %s", (value) => {
		expect(parseReviewFixLink(value)).toBeNull();
	});
	it("refuses to build links from nonopaque identifiers", () => {
		expect(() => buildReviewFixLink({ runId: "a/b" })).toThrow();
		expect(() => buildReviewFixLink({ runId: "a", findingId: "" })).toThrow();
	});
});
