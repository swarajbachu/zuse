import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UserMessageText } from "../../src/components/user-message-text";

describe("user message links", () => {
	it("shows the screenshot's compact PR label with the original destination", () => {
		const url = "https://github.com/swarajbachu/zuse/pull/546";
		const markup = renderToStaticMarkup(
			<UserMessageText text={`${url} testing man`} />,
		);
		expect(markup).toContain(`href="${url}"`);
		expect(markup).toContain(`title="${url}"`);
		expect(markup).toContain(">swarajbachu/zuse#546</span>");
		expect(markup).toContain("site-favicon");
		expect(markup).toContain("</a> testing man");
	});

	it("keeps punctuation, newlines and unknown destinations around multiple links", () => {
		const markup = renderToStaticMarkup(
			<UserMessageText
				text={
					"See (https://github.com/team/repo/issues/42),\n  then https://example.com/docs. Done."
				}
			/>,
		);
		expect(markup).toContain("See (");
		expect(markup).toContain(">team/repo#42</span>");
		expect(markup).toContain("</a>),\n  then ");
		expect(markup).toContain('href="https://example.com/docs"');
		expect(markup).toContain(">https://example.com/docs</span>");
		expect(markup).toContain("</a>. Done.");
	});

	it("keeps user Markdown and HTML literal and ignores non-HTTP URLs", () => {
		const markup = renderToStaticMarkup(
			<UserMessageText
				text={
					"**literal**\n<script>alert(1)</script> javascript:alert(1) file:///tmp/test https://"
				}
			/>,
		);
		expect(markup).toContain("**literal**\n&lt;script&gt;");
		expect(markup).toContain("javascript:alert(1) file:///tmp/test https://");
		expect(markup).not.toContain("<a ");
	});
});
