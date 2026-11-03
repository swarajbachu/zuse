import { useKeybindingDispatch } from "../hooks/use-keybinding-dispatch.ts";
import { useMenuShortcuts } from "../hooks/use-menu-shortcuts.ts";
import { ShortcutsPanel } from "./shortcuts-panel.tsx";

/** Load shortcut subscriptions alongside the shell without blocking its first paint. */
export function ApplicationShortcuts() {
	useMenuShortcuts();
	useKeybindingDispatch();
	return <ShortcutsPanel />;
}
