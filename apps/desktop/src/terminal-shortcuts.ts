import type { WebContents } from "electron";

export const TERMINAL_FOCUS_CHANNEL = "terminal:focus";

/** Keep native menu accelerators from consuming shell control keys. */
export function installTerminalShortcutRouting(contents: WebContents): void {
	let terminalFocused = false;
	contents.on("ipc-message", (event, channel, focused: unknown) => {
		if (
			channel !== TERMINAL_FOCUS_CHANNEL ||
			event.senderFrame !== contents.mainFrame
		)
			return;
		if (typeof focused !== "boolean") return;
		terminalFocused = focused;
		if (!focused) contents.setIgnoreMenuShortcuts(false);
	});
	contents.on("did-start-loading", () => {
		terminalFocused = false;
		contents.setIgnoreMenuShortcuts(false);
	});
	contents.on("before-input-event", (_event, input) => {
		const terminalCommand =
			input.meta &&
			!input.control &&
			!input.alt &&
			// Paste must retain its native accelerator so Electron dispatches the
			// clipboard event consumed by the terminal's renderer.
			["a", "c", "backspace"].includes(input.key.toLowerCase());
		contents.setIgnoreMenuShortcuts(
			terminalFocused && ((input.control && !input.meta) || terminalCommand),
		);
	});
}
