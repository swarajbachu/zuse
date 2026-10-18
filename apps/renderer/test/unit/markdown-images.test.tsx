import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { MarkdownBody } from "../../src/components/markdown-body.tsx";

test.each([
	"/tmp/ipad-preview.png",
	"file:///tmp/ipad-preview.png",
])("loads local markdown images through file access: %s", (path) => {
	const html = renderToStaticMarkup(
		<MarkdownBody>{`![iPad preview](${path})`}</MarkdownBody>,
	);
	expect(html).not.toContain("<img");
	expect(html).toContain("iPad preview");
});

test("preserves remote markdown images", () => {
	const html = renderToStaticMarkup(
		<MarkdownBody>
			{"![Preview](https://example.com/preview.png)"}
		</MarkdownBody>,
	);
	expect(html).toContain('src="https://example.com/preview.png"');
});
