import { describe, expect, it } from "vitest";
import { appendVary, negotiateContent } from "./content-negotiation";

describe("negotiateContent", () => {
	it.each([
		[null, "html"],
		["", "html"],
		["*/*", "html"],
		["text/html", "html"],
		["text/markdown", "markdown"],
		["text/markdown, text/html;q=0.8", "markdown"],
		["text/markdown;q=0.5, text/html;q=0.9", "html"],
		["text/*;q=0.7, text/markdown;q=0.9", "markdown"],
		["text/markdown;q=0, */*;q=1", "html"],
		["application/xml", "unsupported"],
	] as const)("negotiates %s as %s", (accept, expected) => {
		expect(negotiateContent(accept)).toBe(expected);
	});
});

describe("appendVary", () => {
	it("merges values without duplicating header names", () => {
		expect(appendVary("RSC, Accept", "accept")).toBe("RSC, Accept");
		expect(appendVary(null, "Accept")).toBe("Accept");
	});
});
