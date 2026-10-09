import { describe, expect, it } from "vitest";
import { markdownToSlack } from "../src/formatting.ts";
import { turnResultText } from "../src/turn-errors.ts";

describe("agent reply formatting", () => {
	it("formats the headings and bold labels from a repository review", () => {
		expect(
			turnResultText(
				"## Fix first — the product is wrong\n\n**The Analytics page is fake.** /analytics never reads the user's data.\n\n## Security\n\n__Writes skip validation.__",
				"completed",
			),
		).toBe(
			"*Fix first — the product is wrong*\n\n*The Analytics page is fake.* /analytics never reads the user's data.\n\n*Security*\n\n*Writes skip validation.*",
		);
	});
	it("keeps Markdown markers literal inside inline and fenced code", () => {
		expect(
			markdownToSlack(
				"Use `**name**` and `a < b`.\n```ts\n## not a heading\nconst x = '**literal**';\n```\n\n### Next",
			),
		).toBe(
			"Use `**name**` and `a &lt; b`.\n```\n## not a heading\nconst x = '**literal**';\n```\n\n*Next*",
		);
	});
	it("formats links, emphasis, strikethrough, lists and quotes", () => {
		expect(
			markdownToSlack(
				"[Docs](https://example.com?a=1&b=2)\n- **Fix** *this*\n* ~~Old~~\n* Fix *this*\n> Quoted",
			),
		).toBe(
			"<https://example.com?a=1&amp;b=2|Docs>\n• *Fix* _this_\n• ~Old~\n• Fix _this_\n> Quoted",
		);
	});
	it("escapes generated Slack mentions and control characters", () => {
		expect(markdownToSlack("<@U123> <!channel> a & b")).toBe(
			"&lt;@U123&gt; &lt;!channel&gt; a &amp; b",
		);
	});
	it("also formats failed replies and keeps empty-result fallbacks", () => {
		expect(turnResultText("**Failed**", "error")).toContain("\n*Failed*\n");
		expect(turnResultText(undefined, "interrupted")).toContain("interrupted");
	});
});
