import { describe, expect, it } from "vitest";
import {
	isHtmlRenderTool,
	readHtmlRenderResult,
} from "../../src/html-render.ts";

const htmlRender = { attachmentId: "visual-1", title: "Results", height: 480 };
describe("HTML render references", () => {
	it.each([
		"html_render",
		"mcp__zuse__html_render",
		"zuse.html_render",
		"zuse_html_render",
	])("accepts %s", (name) => expect(isHtmlRenderTool(name)).toBe(true));
	it.each([
		"mcp__other__html_render",
		"html_preview",
		"xhtml_render",
	])("rejects %s", (name) => expect(isHtmlRenderTool(name)).toBe(false));
	it.each([
		{ htmlRender },
		JSON.stringify({ htmlRender }),
		{ content: [{ type: "text", text: JSON.stringify({ htmlRender }) }] },
		{ structuredContent: { htmlRender } },
		{ type: "MCP", output: { OkayOutput: { htmlRender } } },
	])("reads provider result envelopes", (value) =>
		expect(readHtmlRenderResult(value)).toEqual(htmlRender));
	it.each([
		{ isError: true, htmlRender },
		{ ErrorOutput: { htmlRender } },
		{ htmlRender: { ...htmlRender, height: Infinity } },
		{ htmlRender: { ...htmlRender, attachmentId: "" } },
		{ htmlRender: { ...htmlRender, height: 2001 } },
		"not json",
	])("rejects invalid or failed results", (value) =>
		expect(readHtmlRenderResult(value)).toBeNull());
	it("bounds recursive envelopes", () => {
		const cycle: Record<string, unknown> = {};
		cycle.output = cycle;
		expect(readHtmlRenderResult(cycle)).toBeNull();
	});
});
