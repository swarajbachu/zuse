import { describe, expect, it } from "vitest";
import { HOME_MARKDOWN, LLMS_TEXT, NOT_FOUND_MARKDOWN } from "./agent-content";

describe("agent-facing content", () => {
	it("publishes a substantial, structured Markdown homepage", () => {
		expect(HOME_MARKDOWN.length).toBeGreaterThan(1500);
		expect(HOME_MARKDOWN).toMatch(/^# Zuse/m);
		expect(HOME_MARKDOWN).toMatch(/^## How Zuse works/m);
		expect(HOME_MARKDOWN).toMatch(/^### 1\. Start a task/m);
		expect(HOME_MARKDOWN).toContain("/developers");
	});

	it("tells agents when to use Zuse and how to discover its contract", () => {
		expect(LLMS_TEXT).toMatch(/^## When to use Zuse/m);
		expect(LLMS_TEXT).toMatch(/^## How agents should interact/m);
		expect(LLMS_TEXT).toContain("/openapi.json");
		expect(LLMS_TEXT).toContain("/sitemap.xml");
	});

	it("gives agents recovery links in a Markdown 404", () => {
		expect(NOT_FOUND_MARKDOWN).toMatch(/^# 404/m);
		for (const path of ["/sitemap.xml", "/llms.txt", "/developers"]) {
			expect(NOT_FOUND_MARKDOWN).toContain(path);
		}
	});
});
