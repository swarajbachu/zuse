import {
	deleteGroupBackward,
	deleteToLineEnd,
	deleteToLineStart,
	insertNewlineAndIndent,
} from "@codemirror/commands";
import type { KeyBinding } from "@codemirror/view";

import type { Command } from "@zuse/contracts";

import {
	CLEAR_CONFIRM_MS,
	DoubleEscape,
} from "../../composer/double-escape.ts";
import { APPLICATION_COMMANDS, dispatchCommand } from "../commands.ts";
import { keybindingsSnapshot } from "../keybindings-client-bus.ts";
import type { ComposerCallbacks } from "./composer.ts";
import { killWith, yank, yankPop } from "./composer-kill-ring.ts";
import { keyToCodeMirrorKey } from "./keybinding-bridge.ts";

/**
 * Build the composer's CodeMirror keymap from the live keybindings store.
 * Rules whose `command` lives in the `composer.*` namespace win over the
 * defaults; rules with malformed keys are skipped (the editor warns about
 * them separately).
 *
 * When the user edits keybindings, the host component reconfigures the
 * composer's keymap compartment with a freshly-built keymap — that's how
 * a rebind takes effect without re-mounting the editor.
 */
export const buildComposerKeymap = (
	callbacks: ComposerCallbacks,
): KeyBinding[] => {
	const rules = keybindingsSnapshot().resolvedRules;
	const bindings: KeyBinding[] = [];

	const ordered = [...rules].reverse();
	const seenKeys = new Set<string>();

	for (const r of ordered) {
		const command = r.rule.command as Command;
		if (!command.startsWith("composer.")) continue;
		const key = keyToCodeMirrorKey(r.shortcut);
		if (key === null) continue;

		if (seenKeys.has(key)) continue;
		seenKeys.add(key);

		const binding = makeComposerBinding(command, key, callbacks);
		if (binding !== null) bindings.push(binding);
	}

	// App shortcuts still fire while typing. Without this, CodeMirror's
	// built-in macOS keys (Ctrl+O split line, Ctrl+T transpose) win first.
	for (const r of ordered) {
		const command = r.rule.command as Command;
		if (!APPLICATION_COMMANDS.has(command)) continue;
		const key = keyToCodeMirrorKey(r.shortcut);
		if (key === null || seenKeys.has(key)) continue;
		seenKeys.add(key);
		bindings.push({
			key,
			preventDefault: true,
			run: (view) => {
				if (view.composing) return false;
				dispatchCommand(command);
				return true;
			},
		});
	}
	return bindings;
};

const escapePresses = new WeakMap<
	import("@codemirror/view").EditorView,
	DoubleEscape
>();
const clearPresses = new WeakMap<
	import("@codemirror/view").EditorView,
	{ readonly presses: DoubleEscape; readonly disarm: () => void }
>();
export const resetComposerInterrupt = (
	view: import("@codemirror/view").EditorView,
): void => {
	escapePresses.get(view)?.reset();
	const clear = clearPresses.get(view);
	clear?.presses.reset();
	clear?.disarm();
};

/**
 * With nothing running, Escape twice clears the draft. The first press only
 * arms the clear so the composer can show a "press Esc again" hint.
 */
const pressClearEscape = (
	view: import("@codemirror/view").EditorView,
	key: string,
	callbacks: ComposerCallbacks,
): boolean => {
	const onClearDraft = callbacks.onClearDraft;
	if (
		key !== "Escape" ||
		onClearDraft === undefined ||
		view.state.doc.length === 0
	) {
		resetComposerInterrupt(view);
		return false;
	}
	let clear = clearPresses.get(view);
	if (clear === undefined) {
		clear = {
			presses: new DoubleEscape(CLEAR_CONFIRM_MS),
			disarm: () => callbacks.onClearArmed?.(false),
		};
		clearPresses.set(view, clear);
	}
	if (!clear.presses.press(view.state.doc)) {
		callbacks.onClearArmed?.(true);
		return true;
	}
	clear.disarm();
	onClearDraft();
	return true;
};

const makeComposerBinding = (
	command: Command,
	key: string,
	callbacks: ComposerCallbacks,
): KeyBinding | null => {
	switch (command) {
		case "composer.deleteToStart":
		case "composer.deleteToEnd":
		case "composer.deleteWord":
			return {
				key,
				run: (view) => {
					if (view.composing) return false;
					return killWith(
						command === "composer.deleteToStart"
							? deleteToLineStart
							: command === "composer.deleteToEnd"
								? deleteToLineEnd
								: deleteGroupBackward,
					)(view);
				},
			};
		case "composer.stash":
			return {
				key,
				preventDefault: true,
				run: (view) => !view.composing && (callbacks.onStash?.() ?? false),
			};
		case "composer.searchHistory":
			return {
				key,
				preventDefault: true,
				run: (view) =>
					!view.composing && (callbacks.onSearchHistory?.() ?? false),
			};
		case "composer.yank":
		case "composer.yankPop":
			return {
				key,
				run: (view) =>
					!view.composing &&
					(command === "composer.yank" ? yank : yankPop)(view),
			};
		case "composer.interrupt":
			return {
				key,
				run: (view) => {
					if (view.composing) {
						resetComposerInterrupt(view);
						return false;
					}
					if (callbacks.canInterrupt?.() === false)
						return pressClearEscape(view, key, callbacks);
					if (key === "Escape") {
						let presses = escapePresses.get(view);
						if (!presses) {
							presses = new DoubleEscape();
							escapePresses.set(view, presses);
						}
						if (!presses.press(view.state.doc)) return true;
					}
					return callbacks.onInterrupt?.() ?? false;
				},
			};
		case "composer.submit":
			return {
				key,
				preventDefault: true,
				run: (view) => !view.composing && callbacks.onSubmit(),
			};
		case "composer.previousMessage":
		case "composer.nextMessage":
			return {
				key,
				run: (view) => {
					if (view.composing || !view.state.selection.main.empty) return false;
					const direction = command === "composer.previousMessage" ? -1 : 1;
					const head = view.state.selection.main.head;
					if (direction === -1 && head !== 0) return false;
					if (direction === 1 && head !== view.state.doc.length) return false;
					return callbacks.onHistory?.(direction) ?? false;
				},
			};
		case "composer.queueSubmit":
			return {
				key,
				preventDefault: true,
				run: (view) => !view.composing && callbacks.onSubmit("queue"),
			};
		case "composer.newline":
			return { key, run: insertNewlineAndIndent };
		case "composer.forceSubmit":
			return {
				key,
				preventDefault: true,
				run: (view) => {
					if (view.composing) return false;

					callbacks.onSubmit("steer");
					return true;
				},
			};
		case "composer.togglePlanMode":
			return {
				key,
				preventDefault: true,
				run: (view) => {
					if (view.composing) return false;
					const cb = callbacks.onTogglePlanMode;
					if (cb === undefined) return false;
					cb();
					return true;
				},
			};
		default:
			return null;
	}
};

/**
 * Stable export name kept so `composer.ts` doesn't need to change its
 * import shape. Returns the same array `buildComposerKeymap` produces —
 * the legacy fixed list is now built once from the live store at
 * construction; reconfigure on change happens via the compartment in
 * `composer.ts`.
 */
export const composerKeymap = (
	callbacks: ComposerCallbacks,
): readonly KeyBinding[] => buildComposerKeymap(callbacks);
