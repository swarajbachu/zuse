const directCodes: Readonly<Record<string, number>> = {
	Backquote: 1,
	Backslash: 2,
	BracketLeft: 3,
	BracketRight: 4,
	Comma: 5,
	Equal: 16,
	IntlBackslash: 17,
	IntlRo: 18,
	IntlYen: 19,
	Minus: 46,
	Period: 47,
	Quote: 48,
	Semicolon: 49,
	Slash: 50,
	AltLeft: 51,
	AltRight: 52,
	Backspace: 53,
	CapsLock: 54,
	ContextMenu: 55,
	ControlLeft: 56,
	ControlRight: 57,
	Enter: 58,
	MetaLeft: 59,
	MetaRight: 60,
	ShiftLeft: 61,
	ShiftRight: 62,
	Space: 63,
	Tab: 64,
	Convert: 65,
	KanaMode: 66,
	NonConvert: 67,
	Delete: 68,
	End: 69,
	Help: 70,
	Home: 71,
	Insert: 72,
	PageDown: 73,
	PageUp: 74,
	ArrowDown: 75,
	ArrowLeft: 76,
	ArrowRight: 77,
	ArrowUp: 78,
	NumLock: 79,
	NumpadAdd: 90,
	NumpadBackspace: 91,
	NumpadClear: 92,
	NumpadClearEntry: 93,
	NumpadComma: 94,
	NumpadDecimal: 95,
	NumpadDivide: 96,
	NumpadEnter: 97,
	NumpadEqual: 98,
	NumpadMemoryAdd: 99,
	NumpadMemoryClear: 100,
	NumpadMemoryRecall: 101,
	NumpadMemoryStore: 102,
	NumpadMemorySubtract: 103,
	NumpadMultiply: 104,
	NumpadParenLeft: 105,
	NumpadParenRight: 106,
	NumpadSubtract: 107,
	NumpadSeparator: 108,
	Escape: 120,
	PrintScreen: 148,
	ScrollLock: 149,
	Pause: 150,
	BrowserBack: 151,
	BrowserFavorites: 152,
	BrowserForward: 153,
	BrowserHome: 154,
	BrowserRefresh: 155,
	BrowserSearch: 156,
	BrowserStop: 157,
	Eject: 158,
	LaunchApp1: 159,
	LaunchApp2: 160,
	LaunchMail: 161,
	MediaPlayPause: 162,
	MediaSelect: 163,
	MediaStop: 164,
	MediaTrackNext: 165,
	MediaTrackPrevious: 166,
	Power: 167,
	Sleep: 168,
	AudioVolumeDown: 169,
	AudioVolumeMute: 170,
	AudioVolumeUp: 171,
	WakeUp: 172,
	Copy: 173,
	Cut: 174,
	Paste: 175,
};

type ClipboardShortcutEvent = Readonly<{
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
}>;

export type GhosttyClipboardShortcut = "copy" | "paste" | "select-all";

/**
 * Classify only shortcuts owned by the host clipboard. In particular, plain
 * Ctrl+C and Ctrl+V remain terminal input so shell/TUI control sequences are
 * never stolen merely because the terminal has a selection.
 */
export function ghosttyClipboardShortcut(
	event: ClipboardShortcutEvent,
): GhosttyClipboardShortcut | null {
	if (event.altKey) return null;
	const key = event.key.toLocaleLowerCase();
	if (event.metaKey && !event.ctrlKey) {
		if (key === "c") return "copy";
		if (key === "v") return "paste";
		if (key === "a") return "select-all";
		return null;
	}
	if (event.ctrlKey && event.shiftKey && !event.metaKey) {
		if (key === "c") return "copy";
		if (key === "v") return "paste";
		if (key === "a") return "select-all";
		return null;
	}
	if (key === "insert" && !event.metaKey) {
		if (event.ctrlKey && !event.shiftKey) return "copy";
		if (event.shiftKey && !event.ctrlKey) return "paste";
	}
	return null;
}

export function ghosttyKeyCode(code: string): number {
	if (code.startsWith("Digit") && code.length === 6) {
		const digit = Number(code.at(-1));
		if (Number.isInteger(digit)) return 6 + digit;
	}
	if (code.startsWith("Key") && code.length === 4) {
		const letter = code.charCodeAt(3) - 65;
		if (letter >= 0 && letter < 26) return 20 + letter;
	}
	if (code.startsWith("Numpad") && /^Numpad\d$/.test(code)) {
		return 80 + Number(code.at(-1));
	}
	if (/^F(?:[1-9]|1\d|2[0-5])$/.test(code)) {
		return 120 + Number(code.slice(1));
	}
	return directCodes[code] ?? 0;
}

export function ghosttyModifiers(event: KeyboardEvent | MouseEvent): number {
	return (
		(event.shiftKey ? 1 : 0) |
		(event.ctrlKey ? 1 << 1 : 0) |
		(event.altKey ? 1 << 2 : 0) |
		(event.metaKey ? 1 << 3 : 0) |
		("getModifierState" in event && event.getModifierState("CapsLock")
			? 1 << 4
			: 0) |
		("getModifierState" in event && event.getModifierState("NumLock")
			? 1 << 5
			: 0)
	);
}

export function unshiftedCodepoint(event: KeyboardEvent): number {
	if (event.code.startsWith("Key") && event.code.length === 4) {
		return event.code.charCodeAt(3) + 32;
	}
	if (event.code.startsWith("Digit") && event.code.length === 6) {
		return event.code.charCodeAt(5);
	}
	if (event.key.length === 1) return event.key.codePointAt(0) ?? 0;
	return 0;
}

export function consumedModifiers(event: KeyboardEvent): number {
	if (event.key.length !== 1) return 0;
	let consumed = 0;
	if (event.shiftKey) consumed |= 1;
	if (event.getModifierState("CapsLock")) consumed |= 1 << 4;
	return consumed;
}
