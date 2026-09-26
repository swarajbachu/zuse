import { describe, expect, it } from "vitest";
import {
	ghosttyClipboardShortcut,
	ghosttyKeyCode,
} from "../../src/terminal/ghostty/key-map.ts";

describe("Ghostty browser key mapping", () => {
	it("maps writing, navigation, function, and keypad codes to the pinned ABI", () => {
		expect(ghosttyKeyCode("KeyA")).toBe(20);
		expect(ghosttyKeyCode("KeyZ")).toBe(45);
		expect(ghosttyKeyCode("Digit0")).toBe(6);
		expect(ghosttyKeyCode("Digit9")).toBe(15);
		expect(ghosttyKeyCode("ArrowUp")).toBe(78);
		expect(ghosttyKeyCode("Numpad7")).toBe(87);
		expect(ghosttyKeyCode("Escape")).toBe(120);
		expect(ghosttyKeyCode("F25")).toBe(145);
		expect(ghosttyKeyCode("NotARealCode")).toBe(0);
	});

	it("keeps interrupt separate from platform clipboard shortcuts", () => {
		const shortcut = (
			key: string,
			modifiers: Readonly<{
				ctrlKey?: boolean;
				metaKey?: boolean;
				shiftKey?: boolean;
				altKey?: boolean;
			}>,
		) =>
			ghosttyClipboardShortcut({
				key,
				ctrlKey: modifiers.ctrlKey ?? false,
				metaKey: modifiers.metaKey ?? false,
				shiftKey: modifiers.shiftKey ?? false,
				altKey: modifiers.altKey ?? false,
			});

		expect(shortcut("c", { metaKey: true })).toBe("copy");
		expect(shortcut("v", { metaKey: true })).toBe("paste");
		expect(shortcut("a", { metaKey: true })).toBe("select-all");
		expect(shortcut("C", { ctrlKey: true, shiftKey: true })).toBe("copy");
		expect(shortcut("V", { ctrlKey: true, shiftKey: true })).toBe("paste");
		expect(shortcut("A", { ctrlKey: true, shiftKey: true })).toBe("select-all");
		expect(shortcut("Insert", { ctrlKey: true })).toBe("copy");
		expect(shortcut("Insert", { shiftKey: true })).toBe("paste");

		// Ctrl+C must always reach the PTY as SIGINT, even when text is selected.
		expect(shortcut("c", { ctrlKey: true })).toBeNull();
		expect(shortcut("a", { ctrlKey: true })).toBeNull();
		expect(shortcut("c", { metaKey: true, altKey: true })).toBeNull();
		expect(shortcut("f", { metaKey: true })).toBeNull();
	});
});
