import { EditorState } from "@codemirror/state";
import type { Decoration } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { parseComposerInput } from "../../src/composer/segment-parser.ts";
import { chipExtensions } from "../../src/lib/codemirror/composer-chips.ts";
import { composerLinkDecorations } from "../../src/lib/codemirror/composer-links.ts";

const decorated = (
	state: EditorState,
	visibleRanges = [{ from: 0, to: state.doc.length }],
) => {
	const ranges: { from: number; to: number; value: Decoration }[] = [];
	composerLinkDecorations({ state, visibleRanges }).between(
		0,
		state.doc.length,
		(from, to, value) => {
			ranges.push({ from, to, value });
		},
	);
	return {
		icons: ranges.filter(({ value }) => value.spec.widget !== undefined),
		links: ranges
			.filter(({ from, to }) => from !== to)
			.map(({ from, to }) => state.doc.sliceString(from, to)),
	};
};

describe("composer link favicons", () => {
	it("reveals the full URL while editing and compacts it when the cursor leaves", () => {
		const url = "https://github.com/team/repo/pull/42";
		let state = EditorState.create({ doc: url, selection: { anchor: 12 } });
		expect(decorated(state).icons[0]?.value.spec.widget.label).toBeNull();
		state = state.update({ selection: { anchor: url.length } }).state;
		expect(decorated(state).icons[0]?.value.spec.widget.label).toBe(
			"team/repo#42",
		);
		expect(state.doc.toString()).toBe(url);
	});

	it("decorates the screenshot URL without changing the outgoing prompt", () => {
		const url = "https://github.com/swarajbachu/zuse/pull/546";
		const state = EditorState.create({ doc: url, extensions: chipExtensions });
		const result = decorated(state);
		expect(result.icons.map(({ from, to }) => [from, to])).toEqual([
			[0, url.length],
		]);
		expect(result.links).toEqual([url]);
		expect(result.icons[0]?.value.spec.widget.label).toBe(
			"swarajbachu/zuse#546",
		);
		expect(parseComposerInput(state, "codex").text).toBe(url);
	});

	it("handles multiple links and surrounding Markdown punctuation", () => {
		const state = EditorState.create({
			doc: "See [docs](https://github.com/docs), then HTTP://example.com.\n<https://wikipedia.org/wiki/Article>",
		});
		expect(decorated(state).links).toEqual([
			"https://github.com/docs",
			"HTTP://example.com",
			"https://wikipedia.org/wiki/Article",
		]);
		expect(decorated(state).icons).toHaveLength(3);
	});

	it("ignores plain text, incomplete URLs and non-HTTP protocols", () => {
		const state = EditorState.create({
			doc: "github.com /tmp/file.ts file:///tmp/test mailto:user@example.com https:// https://?query ftp://example.com",
		});
		expect(decorated(state).icons).toEqual([]);
	});

	it("only builds icons in the visible part of a large draft", () => {
		const hidden = "https://github.com\n";
		const state = EditorState.create({ doc: `${hidden}https://example.com` });
		const result = decorated(state, [
			{ from: hidden.length, to: state.doc.length },
		]);
		expect(result.links).toEqual(["https://example.com"]);
		expect(result.icons.map(({ from }) => from)).toEqual([hidden.length]);
	});

	it("reuses the image when only the path changes but replaces it for a new host", () => {
		const widget = (url: string) =>
			decorated(EditorState.create({ doc: url, selection: { anchor: 10 } }))
				.icons[0]?.value.spec.widget;
		const original = widget("https://github.com/one");
		expect(original.eq(widget("https://github.com/two"))).toBe(true);
		expect(original.eq(widget("https://google.com/two"))).toBe(false);
	});

	it("updates icons when typing or deleting without consuming URL characters", () => {
		let state = EditorState.create({ doc: "Review " });
		state = state.update({
			changes: { from: state.doc.length, insert: "https://github.com" },
		}).state;
		expect(decorated(state).icons.map(({ from }) => from)).toEqual([7]);
		state = state.update({ changes: { from: 7, to: 15 } }).state;
		expect(state.doc.toString()).toBe("Review github.com");
		expect(decorated(state).icons).toEqual([]);
	});
});
