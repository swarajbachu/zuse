import type { ChatId, Command, Session } from "@zuse/wire";
import { defaultModelFor } from "@zuse/wire";

import { createNewSession } from "../components/projects-sidebar";
import { activeChatId, orderedChatTabs } from "./tab-order";
import { useChatsStore } from "../store/chats";
import { useComposerBridge } from "../store/composer-bridge";
import { usePaneFocus } from "../store/pane-focus";
import { useProvidersStore } from "../store/providers";
import { useSessionsStore } from "../store/sessions";
import { useSettingsStore } from "../store/settings";
import { useUiStore } from "../store/ui";
import { useWorkspaceStore } from "../store/workspace";

/* ────────────────────────── Navigation helpers ──────────────────────────
 * Read state via `.getState()` (no subscription) and fire the same store
 * actions the mouse path uses. Tab ordering is shared with the tab strip via
 * `lib/tab-order.ts` so keyboard and click land on the same tab.
 */

/** Sessions belonging to the currently-selected project. */
function currentProjectSessions(): ReadonlyArray<Session> {
  const projectId = useWorkspaceStore.getState().selectedFolderId;
  if (projectId === null) return [];
  return useSessionsStore.getState().sessionsByProject[projectId] ?? [];
}

/** The chat whose sessions fill the tab strip right now. */
function currentChatId(): ChatId | null {
  return activeChatId(
    currentProjectSessions(),
    useSessionsStore.getState().selectedSessionId,
    useChatsStore.getState().selectedChatId,
  );
}

/** Move the active tab by `delta` within the active chat, wrapping around. */
function stepTab(delta: 1 | -1): void {
  const tabs = orderedChatTabs(currentProjectSessions(), currentChatId());
  if (tabs.length === 0) return;
  const selectedId = useSessionsStore.getState().selectedSessionId;
  const idx = tabs.findIndex((t) => t.id === selectedId);
  const base = idx === -1 ? 0 : idx;
  const next = (base + delta + tabs.length) % tabs.length;
  useSessionsStore.getState().select(tabs[next]!.id);
}

/** Select the 1-based Nth tab; no-op if it doesn't exist. */
function selectTabAt(oneBased: number): void {
  const tabs = orderedChatTabs(currentProjectSessions(), currentChatId());
  const target = tabs[oneBased - 1];
  if (target !== undefined) useSessionsStore.getState().select(target.id);
}

/** Select the last tab in the active chat. */
function selectLastTab(): void {
  const tabs = orderedChatTabs(currentProjectSessions(), currentChatId());
  const target = tabs[tabs.length - 1];
  if (target !== undefined) useSessionsStore.getState().select(target.id);
}

/** Open a fresh session in the active chat — the tab-strip "+" button, by key. */
async function newTabInActiveChat(): Promise<void> {
  const chatId = currentChatId();
  if (chatId === null) return;
  const settings = useSettingsStore.getState();
  const providerId = settings.defaultProviderId;
  // Warm path skips the provider refresh when a default model is cached;
  // cold path pays the round-trip first so `create` gets a real model id.
  if (settings.defaultModelByProvider[providerId] === undefined) {
    await useProvidersStore.getState().refresh();
  }
  const fresh = useSettingsStore.getState();
  const model =
    fresh.defaultModelByProvider[providerId] ?? defaultModelFor(providerId);
  await useSessionsStore.getState().create(chatId, providerId, model, {
    runtimeMode: fresh.defaultRuntimeMode,
  });
}

/** Move the selected chat by `delta` within the project, wrapping around. */
function stepChat(delta: 1 | -1): void {
  const projectId = useWorkspaceStore.getState().selectedFolderId;
  if (projectId === null) return;
  const chats = useChatsStore.getState();
  const list = (chats.chatsByProject[projectId] ?? []).filter(
    (c) => c.archivedAt === null,
  );
  if (list.length === 0) return;
  const idx = list.findIndex((c) => c.id === chats.selectedChatId);
  const base = idx === -1 ? 0 : idx;
  const next = (base + delta + list.length) % list.length;
  chats.select(list[next]!.id);
}

/** Move the active right-pane panel by `delta`, wrapping around; opens the
 *  right sidebar first if it's collapsed. */
function stepPanel(delta: 1 | -1): void {
  const ui = useUiStore.getState();
  const chatId = currentChatId();
  if (chatId === null) return;
  const panels = ui.rightPanelsByChat[chatId] ?? [];
  if (panels.length === 0) return;
  if (!ui.rightSidebarOpen) ui.setRightSidebarOpen(true);
  const activeId = ui.activeRightPanelByChat[chatId] ?? null;
  const idx = panels.findIndex((p) => p.id === activeId);
  const base = idx === -1 ? 0 : idx;
  const next = (base + delta + panels.length) % panels.length;
  ui.setActiveRightPanel(panels[next]!.id);
}

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
  "next-tab": () => stepTab(1),
  "prev-tab": () => stepTab(-1),
  "select-tab-1": () => selectTabAt(1),
  "select-tab-2": () => selectTabAt(2),
  "select-tab-3": () => selectTabAt(3),
  "select-tab-4": () => selectTabAt(4),
  "select-tab-5": () => selectTabAt(5),
  "select-tab-6": () => selectTabAt(6),
  "select-tab-7": () => selectTabAt(7),
  "select-tab-8": () => selectTabAt(8),
  "select-last-tab": () => selectLastTab(),
  "new-tab": () => {
    void newTabInActiveChat();
  },
  "next-chat": () => stepChat(1),
  "prev-chat": () => stepChat(-1),
  "next-panel": () => stepPanel(1),
  "prev-panel": () => stepPanel(-1),
  "focus-next-pane": () => usePaneFocus.getState().focusAdjacent(1),
  "focus-prev-pane": () => usePaneFocus.getState().focusAdjacent(-1),
  "open-chat-switcher": () => useUiStore.getState().toggleChatSwitcher(),
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
