// @vitest-environment jsdom
import { expect, it } from "vitest";
import { defaultInstructions, extractHtml, previewDocument } from "../plan.ts";

it("waits for a complete fenced plan and rejects excessive input", () => {
	expect(extractHtml("```html\n<h1>Draft")).toBeNull();
	expect(
		extractHtml("Here is the plan:\n```html\n<h1>Ready</h1>\n```"),
	).toContain("Ready");
	expect(extractHtml("<html><body>Plan</body></html>")).toContain("Plan");
	expect(() => extractHtml("x".repeat(131073))).toThrow("128 KiB");
	expect(defaultInstructions).toContain("Do not implement");
});
it("preserves drawings while stripping executable content and navigation", () => {
	const output = previewDocument(
		'<h1>Plan</h1><svg viewBox="0 0 100 100"><rect width="50" height="50"/><foreignObject><iframe src="https://bad.test"></iframe></foreignObject></svg><script>alert(1)</script><img src="https://bad.test" onerror="alert(1)"><a href="https://bad.test">link</a><meta http-equiv="refresh" content="0;url=https://bad.test"><form action="https://bad.test"><button>Go</button></form>',
	);
	expect(output).toContain("<svg");
	expect(output).toContain("<rect");
	expect(output).toContain("default-src 'none'");
	for (const forbidden of [
		"<script",
		"<iframe",
		"foreignObject",
		"onerror",
		"href=",
		"src=",
		"<form",
		'http-equiv="refresh"',
	])
		expect(output).not.toContain(forbidden);
});
