import type { Command } from "@memoize/wire";

import { createNewSession } from "../components/projects-sidebar";
import { useComposerBridge } from "../store/composer-bridge";
import { useUiStore } from "../store/ui";
import { useWorkspaceStore } from "../store/workspace";

/**
 * One handler per `Command`. Composer / editor commands are no-ops here —
 * they're owned by the matching CodeMirror keymaps (composer-keymap.ts,
 * setup.ts) which build themselves from the live keybindings store. Having
 * them in the registry anyway keeps the dispatcher exhaustive and lets the
 * settings UI render them in the same table as menu commands.
 *
 * Each handler is invoked from either:
 *   - the document-level keybinding dispatcher (`useKeybindingDispatch`)
 *   - the native menu IPC handler (`useMenuShortcuts`)
 *
 * Both call `dispatchCommand` which is the single fan-in point. Stores are
 * referenced via `.getState()` so the registry doesn't subscribe to
 * anything — it just fires effects.
 */
const HANDLERS: Record<Command, () => void> = {
  "new-chat": () => {
    const projectId = useWorkspaceStore.getState().selectedFolderId;
    if (projectId === null) return;
    void createNewSession(projectId);
  },
  "open-project": () => {
    void useWorkspaceStore.getState().add();
  },
  settings: () => {
    const ui = useUiStore.getState();
    ui.setView(ui.view === "settings" ? "chat" : "settings");
  },
  "close-tab": () => {
    // Owned by `app.tsx` directly — kept here for completeness so the
    // settings UI lists Close Tab in the same table as the others. The
    // native menu's Cmd+W still uses its dedicated IPC signal, and the
    // document dispatcher doesn't fire this scope.
  },
  "toggle-left-sidebar": () => {
    const ui = useUiStore.getState();
    ui.setLeftSidebarOpen(!ui.leftSidebarOpen);
  },
  "toggle-right-sidebar": () => {
    const ui = useUiStore.getState();
    ui.setRightSidebarOpen(!ui.rightSidebarOpen);
  },
  "toggle-terminal": () => {
    // Open the sidebar (if closed) and reveal a terminal panel — focus an
    // existing one or add a fresh terminal tab.
    useUiStore.getState().revealPanel("terminal");
  },
  "focus-composer": () => {
    useComposerBridge.getState().focus?.();
  },
  "composer.submit": () => {},
  "composer.newline": () => {},
  "composer.forceSubmit": () => {},
  "composer.togglePlanMode": () => {},
  "editor.save": () => {},
  "editor.annotate": () => {},
};

/**
 * Fire a command. Lookup is type-safe — TypeScript catches any unknown
 * literal. The handler runs synchronously; callers `preventDefault` on
 * the originating event before dispatching when they want the host
 * surface (browser, CodeMirror) to skip its default behaviour.
 */
export function dispatchCommand(command: Command): void {
  const fn = HANDLERS[command];
  fn();
}

/**
 * Commands handled by the document-level keybinding dispatcher. Composer
 * and editor commands are excluded because the matching CodeMirror keymap
 * already handles them inside its own focused element, and double-firing
 * would (a) submit twice and (b) preventDefault on the native typing event.
 */
export const APPLICATION_COMMANDS: ReadonlySet<Command> = new Set<Command>([
  "new-chat",
  "open-project",
  "settings",
  "toggle-left-sidebar",
  "toggle-right-sidebar",
  "toggle-terminal",
  "focus-composer",
  // `close-tab` deliberately omitted — see app.tsx's onCloseTab handler.
]);
