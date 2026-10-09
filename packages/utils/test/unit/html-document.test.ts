import { expect, it } from "vitest";
import {
	HTML_DOCUMENT_CSP,
	prepareHtmlDisplayUrl,
	prepareHtmlDocument,
} from "../../src/html-document.ts";

it("upgrades legacy saved policies in memory without changing Unicode content", () => {
	const source = prepareHtmlDocument("<h1>日本語 🎨</h1>");
	const legacy = source.replaceAll(" zuse-visual-http: zuse-visual-https:", "");
	const src = `data:text/html;base64,${Buffer.from(legacy).toString("base64")}`;
	const rendered = Buffer.from(
		prepareHtmlDisplayUrl(src).slice("data:text/html;base64,".length),
		"base64",
	).toString();
	expect(rendered).toContain("日本語 🎨");
	expect(rendered).toContain(`content="${HTML_DOCUMENT_CSP}"`);
	expect(rendered).not.toContain(
		`content="${HTML_DOCUMENT_CSP.replaceAll(" zuse-visual-http: zuse-visual-https:", "")}"`,
	);
	expect(
		Buffer.from(
			src.slice("data:text/html;base64,".length),
			"base64",
		).toString(),
	).toBe(legacy);
});
