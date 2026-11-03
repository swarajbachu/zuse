import { history, undo } from "@codemirror/commands";
import {
	EditorState,
	type Transaction,
	type TransactionSpec,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeAll, describe, expect, it } from "vitest";

import { chipExtensions } from "../../src/lib/codemirror/composer-chips.ts";
import {
	buildEmojiIndex,
	completeEmojiShortcode,
	composerEmojiShortcodes,
	detectEmojiTrigger,
	type EmojiIndex,
	insideCodeMarkup,
	loadEmojiIndex,
	rankEmojiSuggestions,
} from "../../src/lib/codemirror/composer-emoji.ts";

const fixture = buildEmojiIndex([
	{ emoji: "❤️", names: ["heart"] },
	{ emoji: "💓", names: ["heartbeat"] },
	{ emoji: "🙉", names: ["hear_no_evil"] },
	{ emoji: "👍", names: ["+1", "thumbsup"] },
	{ emoji: "😄", names: ["smile"] },
	{ emoji: "🐱", names: ["cat"] },
	{ emoji: "🎩", names: ["tophat"] },
]);

const detect = (doc: string) => detectEmojiTrigger(doc, doc.length);

describe("emoji trigger detection", () => {
	it("opens after a colon with at least two name characters", () => {
		expect(detect(":he")).toEqual({
			kind: "emoji",
			from: 0,
			to: 3,
			query: "he",
		});
		expect(detect("send :hea")).toMatchObject({ from: 5, query: "hea" });
		expect(detect("(:sm")).toMatchObject({ from: 1, query: "sm" });
		expect(detect("line\n:+1")).toMatchObject({ from: 5, query: "+1" });
	});

	it("stays closed for short, broken or non-shortcode colons", () => {
		expect(detect(":h")).toBeNull();
		expect(detect(":")).toBeNull();
		expect(detect(":-)")).toBeNull();
		expect(detect("10:30")).toBeNull();
		expect(detect("https://ex")).toBeNull();
		expect(detect("a:bc")).toBeNull();
		expect(detect(":he llo")).toBeNull();
		expect(detect(":heart:")).toBeNull();
	});

	it("ignores colons inside code spans and fences", () => {
		expect(detect("run `cmd :he")).toBeNull();
		expect(detect("```\n:he")).toBeNull();
		expect(detect("```\ncode\n```\n:he")).not.toBeNull();
		expect(insideCodeMarkup("a `b` c", 7)).toBe(false);
		expect(insideCodeMarkup("a `b c", 6)).toBe(true);
		expect(insideCodeMarkup("  ~~~\nx", 7)).toBe(true);
	});
});

describe("emoji shortcode completion", () => {
	const complete = (doc: string, index: EmojiIndex = fixture) =>
		completeEmojiShortcode(doc, doc.length, index);

	it("resolves a known name ending at the cursor", () => {
		expect(complete(":heart")).toEqual({ from: 0, emoji: "❤️" });
		expect(complete("I :Heart")).toEqual({ from: 2, emoji: "❤️" });
		expect(complete("[:+1")).toEqual({ from: 1, emoji: "👍" });
	});

	it("leaves unknown names and non-shortcode colons alone", () => {
		expect(complete(":nope")).toBeNull();
		expect(complete("a:heart")).toBeNull();
		expect(complete("10:30")).toBeNull();
		expect(complete("`:heart")).toBeNull();
		expect(complete(":")).toBeNull();
	});
});

describe("emoji suggestion ranking", () => {
	it("puts prefix matches first, shortest name winning", () => {
		expect(rankEmojiSuggestions(fixture, "hea").map((r) => r.name)).toEqual([
			"heart",
			"heartbeat",
			"hear_no_evil",
		]);
	});

	it("falls back to fuzzy matches and dedupes aliases", () => {
		expect(rankEmojiSuggestions(fixture, "tmbs").map((r) => r.emoji)).toEqual([
			"👍",
		]);
		expect(rankEmojiSuggestions(fixture, "zzzz")).toEqual([]);
		expect(rankEmojiSuggestions(fixture, "")).toEqual([]);
	});

	it("caps the list and matches case-insensitively", () => {
		expect(rankEmojiSuggestions(fixture, "HEA", 2).map((r) => r.name)).toEqual([
			"heart",
			"heartbeat",
		]);
	});
});

describe("composer emoji input handler", () => {
	beforeAll(async () => {
		await loadEmojiIndex();
	});

	const extensions = [history(), ...chipExtensions, composerEmojiShortcodes];

	/** Drive the real input handler the way CodeMirror would for a typed key. */
	const type = (doc: string, text: string) => {
		let state = EditorState.create({
			doc,
			selection: { anchor: doc.length },
			extensions,
		});
		const view = {
			get state() {
				return state;
			},
			composing: false,
			dispatch: (tr: Transaction | TransactionSpec) => {
				state = "state" in tr ? tr.state : state.update(tr).state;
			},
		};
		const [handler] = state.facet(EditorView.inputHandler);
		if (handler === undefined) throw new Error("input handler missing");
		const from = doc.length;
		const handled = handler(
			view as unknown as EditorView,
			from,
			from,
			text,
			() =>
				state.update({
					changes: { from, insert: text },
					selection: { anchor: from + text.length },
					userEvent: "input.type",
				}),
		);
		return {
			handled,
			get state() {
				return state;
			},
			view,
		};
	};

	it("replaces a completed shortcode and undoes back to the text", () => {
		const result = type("I :heart", ":");
		expect(result.handled).toBe(true);
		expect(result.state.doc.toString()).toBe("I ❤️");
		expect(result.state.selection.main.head).toBe("I ❤️".length);
		undo(result.view as unknown as EditorView);
		expect(result.state.doc.toString()).toBe("I :heart:");
	});

	it("does not touch unknown shortcodes or times", () => {
		expect(type(":notanemoji", ":").handled).toBe(false);
		expect(type("at 10", ":").handled).toBe(false);
		expect(type("x", "a").handled).toBe(false);
	});
});

describe("emoji dataset", () => {
	it("ranks heart first for the common prefix", async () => {
		const index = await loadEmojiIndex();
		const names = rankEmojiSuggestions(index, "hea").map((r) => r.name);
		expect(names[0]).toBe("heart");
		expect(names.length).toBeLessThanOrEqual(8);
		expect(
			new Set(rankEmojiSuggestions(index, "sm").map((r) => r.emoji)).size,
		).toBe(rankEmojiSuggestions(index, "sm").length);
		expect(index.byName.get("+1")).toBe("👍");
	});
});
