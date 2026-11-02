import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { parseKey } from "@zuse/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerCallbacks } from "../../src/lib/codemirror/composer.ts";
import { buildComposerKeymap } from "../../src/lib/codemirror/composer-keymap.ts";
import { DEFAULT_KEYBINDINGS } from "../../src/lib/default-keybindings.ts";

vi.mock("../../src/lib/keybindings-client-bus.ts", () => ({
	keybindingsSnapshot: () => ({
		resolvedRules: DEFAULT_KEYBINDINGS.map((rule) => ({
			rule,
			shortcut: parseKey(rule.key),
		})),
	}),
}));

const callbacks: ComposerCallbacks = {
	onSubmit: vi.fn(() => true),
	onHistory: vi.fn(() => true),
	onInterrupt: vi.fn(() => true),
	onChange: vi.fn(),
	onTrigger: vi.fn(),
	onFilesDropped: vi.fn(),
};
const editor = (
	doc = "",
	anchor = 0,
	composing = false,
	head = anchor,
): EditorView =>
	({
		state: EditorState.create({ doc, selection: { anchor, head } }),
		composing,
	}) as EditorView;
const press = (key: string, view = editor()) => {
	const binding = buildComposerKeymap(callbacks).find(
		(binding) => binding.key === key,
	);
	expect(binding?.run).toBeTypeOf("function");
	return binding?.run?.(view);
};
beforeEach(() => vi.clearAllMocks());

describe("composer keyboard behavior", () => {
	it("distinguishes normal, steer, and queue submits", () => {
		press("Enter");
		expect(callbacks.onSubmit).toHaveBeenLastCalledWith();
		press("Mod-Enter");
		expect(callbacks.onSubmit).toHaveBeenLastCalledWith("steer");
		press("Alt-Enter");
		expect(callbacks.onSubmit).toHaveBeenLastCalledWith("queue");
	});
	it("keeps arrows in the document except at its boundaries", () => {
		expect(press("ArrowUp", editor("two\nlines", 4))).toBe(false);
		expect(press("ArrowDown", editor("two\nlines", 4))).toBe(false);
		expect(press("ArrowUp", editor("two\nlines", 0))).toBe(true);
		expect(callbacks.onHistory).toHaveBeenLastCalledWith(-1);
		expect(press("ArrowDown", editor("two\nlines", 9))).toBe(true);
		expect(callbacks.onHistory).toHaveBeenLastCalledWith(1);
		expect(press("ArrowUp", editor("selected", 0, false, 3))).toBe(false);
	});
	it("does not send, recall or interrupt during IME composition", () => {
		for (const key of [
			"Enter",
			"Mod-Enter",
			"Alt-Enter",
			"ArrowUp",
			"ArrowDown",
			"Escape",
			"Ctrl-u",
			"Ctrl-k",
			"Ctrl-Backspace",
			"Alt-Backspace",
		]) {
			expect(press(key, editor("", 0, true))).toBe(false);
		}
		expect(callbacks.onSubmit).not.toHaveBeenCalled();
		expect(callbacks.onHistory).not.toHaveBeenCalled();
		expect(callbacks.onInterrupt).not.toHaveBeenCalled();
	});
	it("requires two Escapes in the same editor before stopping", () => {
		const view = editor();
		expect(press("Escape", view)).toBe(true);
		expect(callbacks.onInterrupt).not.toHaveBeenCalled();
		expect(press("Escape", view)).toBe(true);
		expect(callbacks.onInterrupt).toHaveBeenCalledOnce();
	});
	it("does not arm a stop when a popover or idle session owns Escape", () => {
		const view = editor();
		const guarded = { ...callbacks, canInterrupt: () => false };
		const key = buildComposerKeymap(guarded).find(
			(binding) => binding.key === "Escape",
		);
		expect(key?.run?.(view)).toBe(false);
		expect(callbacks.onInterrupt).not.toHaveBeenCalled();
	});
});

it("does not register the native Close Tab chord as a composer edit", () => {
	const keys = buildComposerKeymap(callbacks);
	expect(keys.some((binding) => binding.key === "Ctrl-w")).toBe(false);
	expect(keys.some((binding) => binding.key === "Ctrl-Backspace")).toBe(true);
	expect(keys.some((binding) => binding.key === "Alt-Backspace")).toBe(true);
});
