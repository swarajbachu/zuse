import { redoDepth } from "@codemirror/commands";
import type { Text } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";

const MAX_KILLS = 10;

/**
 * Terminal-style kill ring shared by every composer: line and word deletions
 * keep what they removed so Ctrl+Y can paste it back and Option+Y can cycle
 * through older deletions right after a paste.
 */
const kills: string[] = [];
let lastYank: {
	readonly view: EditorView;
	readonly doc: Text;
	readonly from: number;
	readonly to: number;
	readonly index: number;
} | null = null;

/** Run a deletion command and remember the text it removed. */
export const killWith =
	(deletion: Command): Command =>
	(view) => {
		const before = view.state.doc;
		if (!deletion(view)) return false;
		const text = removedText(before, view.state.doc);
		if (text.length > 0) {
			kills.unshift(text);
			kills.length = Math.min(kills.length, MAX_KILLS);
		}
		lastYank = null;
		return true;
	};

/** The span a single contiguous deletion removed from `before`. */
const removedText = (before: Text, after: Text): string => {
	if (after.length >= before.length) return "";
	const a = before.toString();
	const b = after.toString();
	let start = 0;
	while (start < b.length && a[start] === b[start]) start++;
	let end = 0;
	while (
		end < b.length - start &&
		a[a.length - 1 - end] === b[b.length - 1 - end]
	)
		end++;
	return a.slice(start, a.length - end);
};

/**
 * Paste the most recent deletion. Falls through when nothing was deleted or
 * there is something to redo, so Ctrl+Y keeps working as redo on platforms
 * that bind it that way.
 */
export const yank: Command = (view) => {
	const text = kills[0];
	if (text === undefined || redoDepth(view.state) > 0) return false;
	insertYank(view, text, 0);
	return true;
};

/** Replace the text just pasted with the next older deletion. */
export const yankPop: Command = (view) => {
	const previous = lastYank;
	if (
		previous === null ||
		previous.view !== view ||
		previous.doc !== view.state.doc ||
		kills.length < 2
	)
		return false;
	const index = (previous.index + 1) % kills.length;
	insertYank(view, kills[index] ?? "", index, previous);
	return true;
};

const insertYank = (
	view: EditorView,
	text: string,
	index: number,
	replace?: { readonly from: number; readonly to: number },
): void => {
	const { from, to } = replace ?? view.state.selection.main;
	view.dispatch({
		changes: { from, to, insert: text },
		selection: { anchor: from + text.length },
		userEvent: "input.paste",
		scrollIntoView: true,
	});
	lastYank = {
		view,
		doc: view.state.doc,
		from,
		to: from + text.length,
		index,
	};
};
