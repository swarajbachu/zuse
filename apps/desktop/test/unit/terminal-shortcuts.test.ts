import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
	installTerminalShortcutRouting,
	TERMINAL_FOCUS_CHANNEL,
} from "../../src/terminal-shortcuts.ts";

describe("terminal menu shortcut routing", () => {
	it("protects shell keys only in the focused terminal and resets on navigation", () => {
		const contents = Object.assign(new EventEmitter(), {
			mainFrame: {},
			setIgnoreMenuShortcuts: vi.fn(),
		});
		installTerminalShortcutRouting(contents as unknown as WebContents);
		const focus = (focused: unknown, senderFrame = contents.mainFrame) =>
			contents.emit(
				"ipc-message",
				{ senderFrame },
				TERMINAL_FOCUS_CHANNEL,
				focused,
			);
		const key = (key: string, control = true, meta = false) =>
			contents.emit(
				"before-input-event",
				{},
				{ key, control, meta, alt: false },
			);
		key("r");
		expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
		focus(true);
		for (const letter of ["r", "l", "w", "c", "v", "a", "z"]) {
			key(letter);
			expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
		}
		for (const letter of ["c", "a"]) {
			key(letter, false, true);
			expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
		}
		key("Backspace", false, true);
		expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
		key("w", false, true);
		expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
		focus(false);
		key("r");
		expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
		focus(true, {});
		focus("true");
		key("r");
		expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
		focus(true);
		contents.emit("did-start-loading");
		key("r");
		expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
	});

	it("keeps native Command+V paste enabled across terminal focus and navigation", () => {
		const contents = Object.assign(new EventEmitter(), {
			mainFrame: {},
			setIgnoreMenuShortcuts: vi.fn(),
		});
		installTerminalShortcutRouting(contents as unknown as WebContents);
		const paste = () => {
			contents.emit(
				"before-input-event",
				{},
				{
					key: "v",
					control: false,
					meta: true,
					alt: false,
				},
			);
			expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
		};
		paste();
		contents.emit(
			"ipc-message",
			{ senderFrame: contents.mainFrame },
			TERMINAL_FOCUS_CHANNEL,
			true,
		);
		paste();
		contents.emit(
			"ipc-message",
			{ senderFrame: contents.mainFrame },
			TERMINAL_FOCUS_CHANNEL,
			false,
		);
		paste();
		contents.emit(
			"ipc-message",
			{ senderFrame: contents.mainFrame },
			TERMINAL_FOCUS_CHANNEL,
			true,
		);
		contents.emit("did-start-loading");
		paste();
	});
});
