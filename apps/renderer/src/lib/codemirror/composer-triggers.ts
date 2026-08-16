import type { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

import { allChips } from "./composer-chips.ts";

export type TriggerKind = "slash" | "at";

export interface ActiveTrigger {
	readonly kind: TriggerKind;
	/** Position of the trigger char (`/` or `@`). */
	readonly from: number;
	/** Position immediately after the typed query. */
	readonly to: number;
	/** The query the user has typed after the trigger char. */
	readonly query: string;
}

export type TriggerListener = (trigger: ActiveTrigger | null) => void;

const TRIGGER_CHARS: Record<string, TriggerKind> = {
	"/": "slash",
	"@": "at",
};

/**
 * Walk left from `pos` looking for an unescaped trigger char that starts a
 * slash or at-mention. The trigger only fires when the char is at the
 * start of input or preceded by whitespace — so a URL like `a@b` does not
 * pop the file picker.
 *
 * Returns null if no trigger is active. The trigger range covers from the
 * trigger char inclusive to `pos`; the query is the slice between them
 * minus the trigger char itself.
 */
const detectTrigger = (
	state: EditorState,
	pos: number,
): ActiveTrigger | null => {
	// Bail if the cursor sits inside a chip — chips are atomic and don't
	// accept new typing inside themselves anyway.
	for (const c of allChips(state)) {
		if (pos > c.from && pos < c.to) return null;
	}

	const doc = state.doc;
	// Walk back up to MAX_QUERY chars looking for a trigger char.
	const MAX_QUERY = 64;
	const start = Math.max(0, pos - MAX_QUERY);
	const slice = doc.sliceString(start, pos);

	for (let i = slice.length - 1; i >= 0; i--) {
		const ch = slice[i]!;
		// A whitespace inside the candidate query breaks the trigger.
		if (/\s/.test(ch)) return null;
		const kind = TRIGGER_CHARS[ch];
		if (!kind) continue;
		const triggerAbs = start + i;
		const before =
			triggerAbs === 0 ? "" : doc.sliceString(triggerAbs - 1, triggerAbs);
		// A `/` (or `@`) mid-token — e.g. the `/` in `@apps/` — isn't a real
		// trigger because it isn't preceded by whitespace. Keep walking: there
		// may still be a valid `@` further left that starts the actual trigger.
		if (triggerAbs !== 0 && !/\s/.test(before)) continue;
		return {
			kind,
			from: triggerAbs,
			to: pos,
			query: slice.slice(i + 1),
		};
	}
	return null;
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
