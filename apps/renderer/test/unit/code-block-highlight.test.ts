import { describe, expect, it } from "vitest";

import {
	codeHighlightKey,
	normalizeHighlightedCodeHtml,
	selectCurrentHighlight,
} from "../../src/lib/code-block-highlight.ts";

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
			'<pre><code><span class="line">one</span>\n<span class="line">two</span></code></pre>';
		expect(normalizeHighlightedCodeHtml(html)).toBe(
			'<pre><code><span class="line">one</span><span class="line">two</span></code></pre>',
		);
	});
});
