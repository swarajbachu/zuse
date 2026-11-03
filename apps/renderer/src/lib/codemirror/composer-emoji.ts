import { isolateHistory } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import fuzzysort from "fuzzysort";

import { chipsField } from "./composer-chips.ts";

export interface EmojiTrigger {
	readonly kind: "emoji";
	/** Offset of the opening `:`. */
	readonly from: number;
	readonly to: number;
	/** Shortcode text typed after the `:`, never containing whitespace. */
	readonly query: string;
}

export interface EmojiSuggestion {
	readonly emoji: string;
	/** Shortcode name without colons, e.g. `heart`. */
	readonly name: string;
}

export interface EmojiIndex {
	/** Lower-case shortcode name to emoji, covering every alias. */
	readonly byName: ReadonlyMap<string, string>;
	/** One entry per alias so prefix and fuzzy ranking see every name. */
	readonly entries: ReadonlyArray<EmojiSuggestion>;
}

/** Minimal shape of a `gemoji` record; keeps the index builder data-only. */
export interface EmojiRecord {
	readonly emoji: string;
	readonly names: ReadonlyArray<string>;
}

export const EMOJI_SUGGESTION_LIMIT = 8;

/** Shortcode names are GitHub-style: `heart`, `+1`, `e-mail`, `100`. */
const NAME_CHAR = /[A-Za-z0-9_+-]/u;
/** A shortcode may only open at the start of text, after whitespace or after an opening bracket. */
const OPENER = /[\s([{]/u;
/** Longest shortcode name worth scanning back for. */
const MAX_NAME_LENGTH = 40;
/** Popover opens once this many name characters follow the `:`. */
const MIN_QUERY_LENGTH = 2;

/**
 * Cheap markdown awareness: an odd number of backticks earlier on the same
 * line means an open code span, and an odd number of fence lines above
 * means an open fenced block. Either suppresses emoji handling.
 */
export const insideCodeMarkup = (text: string, pos: number): boolean => {
	let fences = 0;
	let lineStart = 0;
	let backticks = 0;
	for (let index = 0; index < pos; index += 1) {
		const char = text.charCodeAt(index);
		if (char === 10 /* \n */) {
			lineStart = index + 1;
			backticks = 0;
			continue;
		}
		if (index === lineStart && isFenceLine(text, index)) fences += 1;
		if (char === 96 /* ` */) backticks += 1;
	}
	return fences % 2 === 1 || backticks % 2 === 1;
};

const isFenceLine = (text: string, lineStart: number): boolean => {
	let index = lineStart;
	while (index < lineStart + 3 && text[index] === " ") index += 1;
	const marker = text[index];
	return (
		(marker === "`" || marker === "~") &&
		text[index + 1] === marker &&
		text[index + 2] === marker
	);
};

/**
 * Find the `:name` run ending at `cursor`, or null when the text before the
 * cursor is not a shortcode candidate (`10:30`, `https://`, `a:b`, code).
 */
const scanShortcode = (
	text: string,
	cursor: number,
): { readonly from: number; readonly name: string } | null => {
	let start = cursor;
	while (start > 0 && NAME_CHAR.test(text[start - 1] ?? "")) {
		start -= 1;
		if (cursor - start > MAX_NAME_LENGTH) return null;
	}
	if (start === 0 || text[start - 1] !== ":") return null;
	const from = start - 1;
	if (from > 0 && !OPENER.test(text[from - 1] ?? "")) return null;
	if (insideCodeMarkup(text, from)) return null;
	return { from, name: text.slice(start, cursor) };
};

/** Detect an open `:query` suggestion trigger at a plain-text cursor. */
export const detectEmojiTrigger = (
	text: string,
	cursor: number,
): EmojiTrigger | null => {
	const position = Math.max(0, Math.min(cursor, text.length));
	const match = scanShortcode(text, position);
	if (match === null || match.name.length < MIN_QUERY_LENGTH) return null;
	return { kind: "emoji", from: match.from, to: position, query: match.name };
};

/**
 * The replacement for a `:name:` whose closing colon is typed at `pos`, or
 * null when nothing before `pos` is a known shortcode.
 */
export const completeEmojiShortcode = (
	text: string,
	pos: number,
	index: EmojiIndex,
): { readonly from: number; readonly emoji: string } | null => {
	const match = scanShortcode(text, pos);
	if (match === null || match.name.length === 0) return null;
	const emoji = index.byName.get(match.name.toLowerCase());
	return emoji === undefined ? null : { from: match.from, emoji };
};

export const buildEmojiIndex = (
	records: ReadonlyArray<EmojiRecord>,
): EmojiIndex => {
	const byName = new Map<string, string>();
	const entries: EmojiSuggestion[] = [];
	for (const record of records) {
		for (const name of record.names) {
			const key = name.toLowerCase();
			if (byName.has(key)) continue;
			byName.set(key, record.emoji);
			entries.push({ emoji: record.emoji, name });
		}
	}
	return { byName, entries };
};

/**
 * Prefix matches first (shortest name wins, so `hea` ranks `heart` above
 * `heartbeat`), then fuzzy matches fill the remaining slots. Aliases of an
 * emoji already listed are skipped so each row is a distinct emoji.
 */
export const rankEmojiSuggestions = (
	index: EmojiIndex,
	query: string,
	limit = EMOJI_SUGGESTION_LIMIT,
): ReadonlyArray<EmojiSuggestion> => {
	const needle = query.toLowerCase();
	if (needle.length === 0) return [];
	const prefixed = index.entries
		.filter((entry) => entry.name.startsWith(needle))
		.sort(
			(a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name),
		);
	const out: EmojiSuggestion[] = [];
	const seen = new Set<string>();
	const push = (entry: EmojiSuggestion): boolean => {
		if (seen.has(entry.emoji)) return out.length < limit;
		seen.add(entry.emoji);
		out.push(entry);
		return out.length < limit;
	};
	for (const entry of prefixed) if (!push(entry)) return out;
	const fuzzy = fuzzysort.go(needle, index.entries, {
		key: "name",
		threshold: 0.3,
		limit: limit * 2,
	});
	for (const result of fuzzy) if (!push(result.obj)) break;
	return out;
};

let loadedIndex: EmojiIndex | null = null;
let loading: Promise<EmojiIndex> | null = null;

/** The emoji index if it has already been loaded; never triggers a load. */
export const loadedEmojiIndex = (): EmojiIndex | null => loadedIndex;

/**
 * Lazily import the emoji table the first time a shortcode trigger appears
 * so the dataset stays out of the startup bundle. The built index is cached
 * for the lifetime of the renderer; a failed load can be retried.
 */
export const loadEmojiIndex = (): Promise<EmojiIndex> => {
	if (loadedIndex !== null) return Promise.resolve(loadedIndex);
	loading ??= import("gemoji").then(
		(module) => {
			loadedIndex = buildEmojiIndex(module.gemoji);
			return loadedIndex;
		},
		(error: unknown) => {
			loading = null;
			throw error;
		},
	);
	return loading;
};

/** Replace the trigger range with the chosen emoji as plain text. */
export const insertEmojiSuggestion = (
	view: EditorView,
	trigger: EmojiTrigger,
	emoji: string,
): void => {
	view.dispatch({
		changes: { from: trigger.from, to: trigger.to, insert: emoji },
		selection: { anchor: trigger.from + emoji.length },
	});
	view.focus();
};

/**
 * Typing the closing `:` of a known shortcode swaps `:heart:` for ❤️. The
 * typed colon lands first, then the rewrite is its own history event so a
 * single undo restores the shortcode text. When the emoji table is not
 * loaded yet the colon is left alone and the load is kicked off instead.
 */
export const composerEmojiShortcodes = EditorView.inputHandler.of(
	(view, from, to, text, insert) => {
		if (text !== ":" || from !== to || view.composing) return false;
		const { selection, doc } = view.state;
		if (selection.ranges.length !== 1 || !selection.main.empty) return false;
		const before = doc.sliceString(0, from);
		const index = loadedEmojiIndex();
		if (index === null) {
			if (scanShortcode(before, from) !== null) void loadEmojiIndex();
			return false;
		}
		const match = completeEmojiShortcode(before, from, index);
		if (match === null) return false;
		const chips = view.state.field(chipsField, false) ?? [];
		if (chips.some((chip) => chip.from < from && chip.to > match.from))
			return false;
		view.dispatch(insert());
		view.dispatch({
			changes: { from: match.from, to: from + 1, insert: match.emoji },
			selection: { anchor: match.from + match.emoji.length },
			userEvent: "input.type",
			annotations: isolateHistory.of("full"),
		});
		return true;
	},
);
