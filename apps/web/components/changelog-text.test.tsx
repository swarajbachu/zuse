import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import changelogData from "@/content/changelog.json";
import { ChangelogText } from "./changelog-text";

it("renders the migration installation link and preserves surrounding text", () => {
	const release = changelogData.find((entry) => entry.version === "0.25.1");
	const text = release?.sections
		.flatMap((section) => section.items)
		.find((item) => item.includes("will be discontinued"));
	expect(text).toBeDefined();
	const html = renderToStaticMarkup(<ChangelogText text={text ?? ""} />);
	expect(html).toContain('href="https://github.com/opcodehq/zuse#install"');
	expect(html).toContain(
		"This version of Zuse will be discontinued soon. Install the new Zuse from ",
	);
	expect(html).toContain(">opcodehq/zuse</a> to continue receiving updates");
	expect(html).not.toContain("[opcodehq/zuse]");
});

it("renders multiple links without losing intervening text", () => {
	const html = renderToStaticMarkup(
		<ChangelogText text="See [one](https://example.com/one) and [two](https://example.com/two)." />,
	);
	expect(html).toContain('href="https://example.com/one"');
	expect(html).toContain("</a> and ");
	expect(html).toContain('href="https://example.com/two"');
	expect(html).toContain("</a>.</span>");
});

it("keeps unsafe link schemes as text and escapes HTML", () => {
	const html = renderToStaticMarkup(
		<ChangelogText
			text={"[unsafe](javascript:alert(1)) <script>bad</script>"}
		/>,
	);
	expect(html).not.toContain("<a");
	expect(html).not.toContain("<script>");
	expect(html).toContain("[unsafe](javascript:alert(1))");
	expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;");
});
