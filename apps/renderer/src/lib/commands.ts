import type { Command } from "@zuse/contracts";
import { createDeferredRuntime } from "./deferred-runtime.ts";

const handlers = createDeferredRuntime(() => import("./command-handlers.ts"));

/** Load command handlers on first interaction, preserving dispatch order while loading. */
export function dispatchCommand(command: Command): void {
	handlers.dispatch((runtime) => runtime.dispatchCommand(command));
}

/**
 * Commands handled by the document-level keybinding dispatcher. Composer
 * and editor commands are excluded because the matching CodeMirror keymap
 * already handles them inside its own focused element, and double-firing
 * would (a) submit twice and (b) preventDefault on the native typing event.
 */
export const APPLICATION_COMMANDS: ReadonlySet<Command> = new Set<Command>([
	"search-files",
	"new-chat",
	"open-project",
	"settings",
	"toggle-left-sidebar",
	"toggle-right-sidebar",
	"toggle-terminal",
	"focus-composer",
	"next-tab",
	"prev-tab",
	"select-tab-1",
	"select-tab-2",
	"select-tab-3",
	"select-tab-4",
	"select-tab-5",
	"select-tab-6",
	"select-tab-7",
	"select-tab-8",
	"select-last-tab",
	"new-tab",
	"next-chat",
	"prev-chat",
	"next-panel",
	"prev-panel",
	"focus-next-pane",
	"focus-prev-pane",
	"open-chat-switcher",
	// `close-tab` deliberately omitted — see app.tsx's onCloseTab handler.
]);
