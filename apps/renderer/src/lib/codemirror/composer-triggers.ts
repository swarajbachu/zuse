import type { EditorState } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import {
	type ComposerTrigger,
	type ComposerTriggerKind,
	detectComposerTrigger,
} from "@zuse/client-runtime/composer-trigger";

import { allChips } from "./composer-chips.ts";
import { detectEmojiTrigger, type EmojiTrigger } from "./composer-emoji.ts";

export type TriggerKind = ComposerTriggerKind | EmojiTrigger["kind"];

/**
 * Shared sigil triggers plus the renderer-only `:shortcode` emoji trigger,
 * which has its own prefix, length and code-markup rules.
 */
export type ActiveTrigger = ComposerTrigger | EmojiTrigger;

export type TriggerListener = (trigger: ActiveTrigger | null) => void;

const detectTrigger = (
	state: EditorState,
	pos: number,
): ActiveTrigger | null => {
	for (const c of allChips(state)) {
		if (pos > c.from && pos < c.to) return null;
	}

	const text = state.doc.toString();
	return detectComposerTrigger(text, pos) ?? detectEmojiTrigger(text, pos);
};

class TriggerPluginValue {
	last: ActiveTrigger | null = null;
	constructor(
		readonly view: EditorView,
		readonly listener: TriggerListener,
	) {}

	update(update: ViewUpdate) {
		if (!update.docChanged && !update.selectionSet) return;
		const sel = update.state.selection.main;
		if (!sel.empty) {
			this.emit(null);
			return;
		}
		const trigger = detectTrigger(update.state, sel.head);
		this.emit(trigger);
	}

	destroy() {
		this.listener(null);
	}

	emit(next: ActiveTrigger | null) {
		const a = this.last;
		const same =
			a !== null &&
			next !== null &&
			a.kind === next.kind &&
			a.from === next.from &&
			a.to === next.to &&
			a.query === next.query;
		if (same) return;
		this.last = next;
		this.listener(next);
	}
}

export const composerTriggerPlugin = (listener: TriggerListener) =>
	ViewPlugin.define((view) => new TriggerPluginValue(view, listener));
