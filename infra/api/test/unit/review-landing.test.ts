import { describe, expect, it } from "vitest";
import { reviewLanding } from "../../src/review-landing.ts";
import { screenReviewOutput } from "../../src/review-output-screen.ts";

describe("public review navigation", () => {
	it("contains opaque navigation only and disables scripts and referrer leaks", async () => {
		const response = reviewLanding(
			new Request(
				"https://api.zuse.test/review/fix?runId=run-123&findingId=bug-1",
			),
		);
		expect(response?.status).toBe(200);
		expect(response?.headers.get("cache-control")).toBe("no-store");
		expect(response?.headers.get("content-security-policy")).toContain(
			"default-src 'none'",
		);
		expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
		const html = await response?.text();
		expect(html).toContain("zuse://");
		expect(html).toContain("reviewRunId=run-123");
		expect(html).not.toContain("<script");
	});
	it.each([
		"runId=x&runId=y",
		"runId=x&findingId=y&findingId=z",
		"runId=x&extra=value",
		`runId=${encodeURIComponent("<script>")}`,
		"findingId=y",
	])("rejects invalid navigation %s", (query) => {
		expect(
			reviewLanding(new Request(`https://api.zuse.test/review/fix?${query}`))
				?.status,
		).toBe(400);
	});
});
describe("review publication output screening", () => {
	it("allows ordinary evidence but rejects known and recognizable secrets", () => {
		expect(
			screenReviewOutput("Caller fails when accountId is undefined."),
		).toBe(true);
		for (const text of [
			`ghp_${"a".repeat(30)}`,
			"-----BEGIN PRIVATE KEY-----",
			`authorization: Bearer ${"x".repeat(24)}`,
			`refresh_token: '${"x".repeat(24)}'`,
			"message\u0000tail",
		])
			expect(screenReviewOutput(text)).toBe(false);
		expect(
			screenReviewOutput("repo says my-secret-canary", ["my-secret-canary"]),
		).toBe(false);
	});
});
