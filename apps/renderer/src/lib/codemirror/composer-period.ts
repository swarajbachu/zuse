import { isolateHistory } from "@codemirror/commands";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { chipsField } from "./composer-chips.ts";

const SENTENCE_END = /[\p{L}\p{N})\]}"'’”]/u;

/**
 * Whether a space typed at `pos` completes a double space after a word, so
 * the space before `pos` should become a period. Mirrors the system
 * text-input rule: only after a letter, digit or closing bracket/quote, so
 * runs of spaces, existing punctuation and chips are left alone.
 */
export const completesDoubleSpacePeriod = (
	state: EditorState,
	pos: number,
): boolean => {
	if (pos < 2) return false;
	const before = state.doc.sliceString(pos - 2, pos);
	if (before[1] !== " " || !SENTENCE_END.test(before[0] ?? "")) return false;
	const chips = state.field(chipsField, false) ?? [];
	return !chips.some((chip) => chip.from < pos && chip.to > pos - 2);
};

/**
 * Typing two spaces after a word inserts a period, like native text fields.
 * The typed space lands first, then the rewrite is its own history event so
 * a single undo restores the two spaces.
 */
export const composerDoubleSpacePeriod = EditorView.inputHandler.of(
	(view, from, to, text, insert) => {
		if (text !== " " || from !== to || view.composing) return false;
		const { selection } = view.state;
		if (selection.ranges.length !== 1 || !selection.main.empty) return false;
		if (!completesDoubleSpacePeriod(view.state, from)) return false;
		view.dispatch(insert());
		view.dispatch({
			changes: { from: from - 1, to: from + 1, insert: ". " },
			userEvent: "input.type",
			annotations: isolateHistory.of("full"),
		});
		return true;
	},
);
