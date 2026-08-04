import { createHighlighter } from "shiki";
import { describe, expect, it } from "vitest";
import {
	codeHighlightKey,
	normalizeHighlightedCodeHtml,
	selectCurrentHighlight,
} from "../../src/lib/code-block-highlight.ts";
import { SHIKI_THEME, SHIKI_THEMES } from "../../src/lib/shiki-config.ts";

describe("code block highlighting", () => {
	it("never paints stale highlighted markup for newer streaming source", () => {
		const previousKey = codeHighlightKey({ code: "const a = 1", lang: "ts" });
		const currentKey = codeHighlightKey({
			code: "const a = 1\nconst b = 2",
			lang: "ts",
		});

		expect(
			selectCurrentHighlight(
				{ key: previousKey, html: "<pre>stale</pre>" },
				currentKey,
			),
		).toBeNull();
	});

	it("reuses markup only for the exact source and language", () => {
		const key = codeHighlightKey({ code: "echo ok", lang: "bash" });
		expect(selectCurrentHighlight({ key, html: "<pre>ready</pre>" }, key)).toBe(
			"<pre>ready</pre>",
		);
		expect(codeHighlightKey({ code: "echo ok", lang: "sh" })).not.toBe(key);
	});

	it("removes Shiki separator nodes that create blank visual rows", () => {
		const html =
			'<pre class="shiki" tabindex="0"><code><span class="line" data-line="1">one</span>\n<span class="line" data-line="2"></span>\n<span class="line" data-line="3">two</span></code></pre>';
		expect(normalizeHighlightedCodeHtml(html)).toBe(
			'<pre class="shiki"><code><span class="line" data-line="1">one</span><span class="line" data-line="2"></span><span class="line" data-line="3">two</span></code></pre>',
		);
	});

	it("normalizes the production Shiki line and focus markup", async () => {
		const highlighter = await createHighlighter({
			themes: [...SHIKI_THEMES],
			langs: ["js"],
		});
		try {
			const raw = highlighter.codeToHtml("one\n\ntwo", {
				lang: "js",
				theme: SHIKI_THEME,
				transformers: [
					{
						line(node, line) {
							node.properties["data-line"] = String(line);
						},
					},
				],
			});
			const normalized = normalizeHighlightedCodeHtml(raw);

			expect(raw).toContain('class="line" data-line="2"');
			expect(normalized).not.toMatch(/\n(?=<span class="line"(?:\s|>))/);
			expect(normalized).not.toContain("tabindex=");
			expect(normalized.match(/<span class="line"/g)).toHaveLength(3);
		} finally {
			highlighter.dispose();
		}
	});
});
