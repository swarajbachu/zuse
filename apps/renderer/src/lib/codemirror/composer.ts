import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
	EditorView,
	type KeyBinding,
	keymap,
	placeholder,
} from "@codemirror/view";

import {
	addChipEffect,
	type ChipMeta,
	type ChipRange,
	type ChipTokenResolver,
	chipExtensions,
	chipResolverFacet,
	isChipEffect,
} from "./composer-chips.ts";
import {
	buildComposerKeymap,
	composerKeymap,
	resetComposerInterrupt,
} from "./composer-keymap.ts";
import { composerLinks } from "./composer-links.ts";
import { composerTheme } from "./composer-theme.ts";
import {
	type ActiveTrigger,
	composerTriggerPlugin,
} from "./composer-triggers.ts";

const composerKeymapCompartment = new WeakMap<EditorView, Compartment>();
const composerPlaceholderCompartment = new WeakMap<EditorView, Compartment>();

export type ComposerCallbacks = {
	/**
	 * Called when the user submits (Enter, Cmd+Enter, etc.). Returns whether the
	 * submit was handled — if `false`, default keybindings (e.g. inserting a
	 * newline) take over. Useful for guards like "popover is open" where the
	 * Enter should be swallowed by the popover instead of submitting.
	 */
	readonly onSubmit: (mode?: "steer" | "queue") => boolean;
	readonly canInterrupt?: () => boolean;
	readonly onInterrupt?: () => boolean;
	readonly onHistory?: (direction: -1 | 1) => boolean;
	readonly onChange: (doc: string) => void;
	readonly onSnapshotChange?: (state: EditorState) => void;
	readonly onTrigger: (trigger: ActiveTrigger | null) => void;
	/**
	 * Called when one or more files are dropped onto the editor surface.
	 * CodeMirror's default drop handler treats file drops as text paste —
	 * we override that so image attachments take the same code path as
	 * paperclip / paste.
	 */
	readonly onFilesDropped: (files: ReadonlyArray<File>) => void;
	/**
	 * Called when plain text is pasted into the editor. Return `true` to
	 * consume the paste (CodeMirror will not insert the text) — used to divert
	 * a large paste into a `.context/files` attachment instead of flooding the
	 * composer. Return `false` to let CodeMirror insert the text normally.
	 *
	 * This must live at the CodeMirror layer (not a React `onPaste`): CM's own
	 * paste handler inserts the text at the editor DOM before the event bubbles
	 * to React, so a React-level `preventDefault` fires too late to stop it.
	 */
	readonly onTextPaste?: (text: string) => boolean;
	/**
	 * Toggle plan mode. Bound to `Shift+Tab` in the composer keymap. The
	 * caller is responsible for the actual mode flip and any visual
	 * feedback (chip, dashed accent on the composer card).
	 */
	readonly onTogglePlanMode?: () => void;
};

export type ComposerCreateParams = {
	readonly parent: HTMLElement;
	readonly initialDoc?: string;
	readonly placeholderText: string;
	readonly callbacks: ComposerCallbacks;
	/**
	 * Turns a canonical chip token pasted as plain text back into chip
	 * metadata so cut/copy/paste round-trips chips, not just their tokens.
	 */
	readonly resolveChipToken?: ChipTokenResolver;
};

/**
 * Build the prose-mode composer view. No gutter, no line numbers, no fold
 * markers; soft-wrap on; the auto-grow is handled in CSS via `min-height` /
 * `max-height` on the container so the view itself stays simple.
 *
 * The returned view's DOM is mounted into `parent`. Tear down with
 * `view.destroy()` when the composer unmounts.
 */
export const createComposerView = ({
	parent,
	initialDoc = "",
	placeholderText,
	callbacks,
	resolveChipToken,
}: ComposerCreateParams): EditorView => {
	const userKeymapCompartment = new Compartment();
	const placeholderCompartment = new Compartment();
	const buildUserKeymap = (): readonly KeyBinding[] =>
		composerKeymap(callbacks);

	const extensions: Extension[] = [
		history(),
		placeholderCompartment.of(placeholder(placeholderText)),
		EditorView.contentAttributes.of({ "aria-label": "Message composer" }),
		EditorView.lineWrapping,
		composerTheme,
		...chipExtensions,
		composerLinks,
		...(resolveChipToken !== undefined
			? [chipResolverFacet.of(resolveChipToken)]
			: []),
		composerTriggerPlugin(callbacks.onTrigger),

		userKeymapCompartment.of(keymap.of([...buildUserKeymap()])),
		keymap.of([
			...historyKeymap,

			...defaultKeymap,
		]),
		EditorView.updateListener.of((u) => {
			if (u.docChanged) callbacks.onChange(u.state.doc.toString());
			if (
				callbacks.onSnapshotChange !== undefined &&
				(u.docChanged ||
					u.transactions.some((tr) => tr.effects.some(isChipEffect)))
			) {
				callbacks.onSnapshotChange(u.state);
			}
		}),

		EditorView.domEventObservers({
			keydown: (event, view) => {
				if (event.key !== "Escape" || event.repeat)
					resetComposerInterrupt(view);
			},
			blur: (_event, view) => resetComposerInterrupt(view),
		}),
		EditorView.domEventHandlers({
			dragover: (event) => {
				if (event.dataTransfer?.types.includes("Files") === true) {
					event.preventDefault();
					event.dataTransfer.dropEffect = "copy";
					return true;
				}
				return false;
			},
			drop: (event) => {
				const files = event.dataTransfer?.files;
				if (files === undefined || files.length === 0) return false;
				event.preventDefault();

				event.stopPropagation();
				callbacks.onFilesDropped(Array.from(files));
				return true;
			},

			paste: (event) => {
				const data = event.clipboardData;
				if (data === null || data === undefined) return false;
				if (data.files.length > 0) return false;
				const text = data.getData("text/plain");
				if (text === "") return false;
				const consumed = callbacks.onTextPaste?.(text) ?? false;
				if (!consumed) return false;
				event.preventDefault();
				event.stopPropagation();
				return true;
			},
		}),
	];

	const view = new EditorView({
		parent,
		state: EditorState.create({
			doc: initialDoc,
			extensions,
		}),
	});

	composerKeymapCompartment.set(view, userKeymapCompartment);
	composerPlaceholderCompartment.set(view, placeholderCompartment);
	return view;
};

/** Swap the placeholder in place, keeping the draft, cursor and focus. */
export const setComposerPlaceholder = (
	view: EditorView,
	placeholderText: string,
): void => {
	const compartment = composerPlaceholderCompartment.get(view);
	if (compartment === undefined) return;
	view.dispatch({
		effects: compartment.reconfigure(placeholder(placeholderText)),
	});
};

/**
 * Re-derive the composer's user-bindable keymap from the current
 * keybindings store and dispatch a compartment reconfigure on the view.
 * Call this after every keybindings ClientBus emit — keybinding
 * edits take effect immediately, no re-mount, no lost cursor.
 */
export const reconfigureComposerKeymap = (
	view: EditorView,
	callbacks: ComposerCallbacks,
): void => {
	const compartment = composerKeymapCompartment.get(view);
	if (compartment === undefined) return;
	view.dispatch({
		effects: compartment.reconfigure(
			keymap.of([...buildComposerKeymap(callbacks)]),
		),
	});
};

/** Replace the entire document — used by submit + `/clear`. */
export const setComposerDoc = (view: EditorView, doc: string): void => {
	view.dispatch({
		changes: { from: 0, to: view.state.doc.length, insert: doc },
		selection: { anchor: doc.length },
	});
};

export const composerDoc = (view: EditorView): string =>
	view.state.doc.toString();

export const restoreComposerChips = (
	view: EditorView,
	chips: readonly ChipRange[],
): void => {
	if (chips.length === 0) return;
	view.dispatch({
		effects: chips
			.filter((chip) => chip.from >= 0 && chip.to <= view.state.doc.length)
			.map((chip) => addChipEffect.of(chip)),
	});
};

/**
 * Replace `[from, to)` in the document with `tokenText` and register a chip
 * over the inserted range. Used by the slash + file popovers when the user
 * confirms a suggestion. A trailing space is inserted after the chip so the
 * cursor lands ready for the next word — matches the spec's `@chat-comp` →
 * inserts chip and the trigger literal is consumed behaviour.
 */
export const replaceWithChip = (
	view: EditorView,
	from: number,
	to: number,
	tokenText: string,
	meta: ChipMeta,
): void => {
	const insertText = tokenText + " ";
	const chipFrom = from;
	const chipTo = from + tokenText.length;
	view.dispatch({
		changes: { from, to, insert: insertText },
		selection: { anchor: from + insertText.length },
		effects: addChipEffect.of({ from: chipFrom, to: chipTo, meta }),
	});
	view.focus();
};

export type { ActiveTrigger } from "./composer-triggers.ts";
