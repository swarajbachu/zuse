import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseReport } from "../report.ts";

describe("JUnit reports", () => {
	it("preserves all suites, statuses and immutable failure details", () => {
		const results = parseReport(
			readFileSync(new URL("../fixtures/results.xml", import.meta.url), "utf8"),
			"reports/results.xml",
		);
		expect(results).toHaveLength(5);
		expect(
			results.filter((item) => item.title.startsWith("FAILED")),
		).toHaveLength(2);
		expect(
			results.find((item) => item.title.includes("expired"))?.text,
		).toContain("received accepted");
		expect(results.at(-1)?.title).toContain("PASSED");
		expect(new Set(results.map((item) => item.id)).size).toBe(5);
	});
	it("handles an empty suite", () =>
		expect(parseReport("<testsuite/>", "empty.xml")).toEqual([]));
	it("rejects malformed, oversized and entity-bearing XML", () => {
		for (const xml of [
			"<testsuite>",
			'<!DOCTYPE testsuite [<!ENTITY x SYSTEM "file:///etc/passwd">]><testsuite/>',
			"x".repeat(1_500_001),
		])
			expect(() => parseReport(xml, "bad.xml")).toThrow();
	});
});
