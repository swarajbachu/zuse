import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { MarkdownBody } from "../../src/components/markdown-body.tsx";

test("renders GitHub review HTML and markdown without truncating the body", () => {
	const html = renderToStaticMarkup(
		<MarkdownBody githubHtml>
			{
				"<h3>Review summary</h3>\n\n**Keep the context**\n\n<details><summary>File details</summary>\n\nLast paragraph with [workflow](https://github.com/o/r/actions/runs/1).\n\n</details>"
			}
		</MarkdownBody>,
	);
	expect(html).toContain("<h3>Review summary</h3>");
	expect(html).toContain("<strong>Keep the context</strong>");
	expect(html).toContain("Last paragraph");
	expect(html).toContain("https://github.com/o/r/actions/runs/1");
	expect(html).toContain("<summary>File details</summary>");
});

test("sanitizes scripts, event handlers and unsafe links from GitHub comments", () => {
	const html = renderToStaticMarkup(
		<MarkdownBody githubHtml>
			{
				'<script>alert(1)</script><img src="https://example.com/logo.png" onerror="alert(2)"><a href="javascript:alert(3)">unsafe</a><iframe src="https://example.com"></iframe>'
			}
		</MarkdownBody>,
	);
	expect(html).not.toContain("<script");
	expect(html).not.toContain("onerror");
	expect(html).not.toContain("javascript:");
	expect(html).not.toContain("<iframe");
});
