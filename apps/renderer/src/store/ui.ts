import { create } from "zustand";

import type { ChatId, CodeAnnotation, FolderId, WorktreeId } from "@zuse/contracts";

import { useChatsStore } from "./chats.ts";

/**
 * Top-level renderer view. The settings page replaces the chat surface in the
 * main pane so users have a real settings page rather than a slide-in drawer.
 */
export type View = "chat" | "settings";

/**
 * Which sub-surface of the settings page is active. `general` / `providers` /
 * `workspace` are global; a `repository` section pins to a specific project
 * so its overrides + worktree list render in the right pane.
 */
export type SettingsSection =
  | { readonly kind: "general" }
  | { readonly kind: "providers" }
  | { readonly kind: "workspace" }
  | { readonly kind: "devices" }
  | { readonly kind: "pokedex" }
  | { readonly kind: "browser" }
  | { readonly kind: "notch" }
  | { readonly kind: "diagnostics" }
  | { readonly kind: "shortcuts" }
  | { readonly kind: "developer" }
  | { readonly kind: "repository"; readonly projectId: FolderId };

/**
 * Which surface the main pane is showing. The chat tab is always available;
 * the file tab only exists when `openFile !== null`. Opening a different file
 * replaces (never stacks) the file tab — see specs/0.02-MVP/features/file-viewer.md.
 */
export type MainTab = "chat" | "file" | "archives" | "usage";

/**
 * Whether the Usage dashboard shows every project's usage (`global`, opened
 * from the sidebar footer) or just the selected project's usage across all its
 * sessions (`project`, opened from a project's context menu).
 */
export type UsageScope = "global" | "project";

/**
 * Panel kinds the right-hand dock can host. The dock is user-managed: panels
 * are added from a launcher / "+" menu and closed individually, rather than
 * being a fixed tab set.
 */
export type PanelKind =
  | "files"
  | "terminal"
  | "changes"
  | "pr"
  | "browser"
  | "mobile";

/**
 * Kinds that may have at most one open instance. Terminal is the only
 * multi-instance kind — each terminal is its own dock tab.
 */
export const SINGLETON_PANEL_KINDS: ReadonlySet<PanelKind> = new Set([
  "files",
  "changes",
  "pr",
  "browser",
  "mobile",
]);

/**
 * A panel tab in the right dock. `id` is a stable per-tab key used to
 * activate/close it. Terminal panels also carry a chat-relative `slot`
 * (0-based) that resolves to the owning chat's Nth terminal instance at
 * render time — see `terminals.ts` `ensureSlot`. The dock layout is per
 * sidebar-chat (`rightPanelsByChat`), so each chat keeps its own set of open
 * tabs and terminals; the singletons are context-aware internally.
 */
export type PanelInstance =
  | { readonly id: string; readonly kind: "files" }
  | { readonly id: string; readonly kind: "changes" }
  | { readonly id: string; readonly kind: "pr" }
  | { readonly id: string; readonly kind: "browser" }
  | { readonly id: string; readonly kind: "mobile" }
  | { readonly id: string; readonly kind: "terminal"; readonly slot: number };

/**
 * Which body the file viewer is showing. `edit` is the CodeMirror editor;
 * `diff` is the side-by-side patch view (working tree vs HEAD); `preview`
 * renders saved markdown / HTML files. Toggled in the toolbar; defaults set
 * per entry point.
 */
export type FileView = "edit" | "diff" | "preview";

const PREVIEWABLE_EXTENSIONS = new Set([
  ".htm",
  ".html",
  ".markdown",
  ".md",
  ".mdown",
  ".mkd",
]);

export const isPreviewableFileName = (name: string): boolean => {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return false;
  return PREVIEWABLE_EXTENSIONS.has(lower.slice(dot));
};

const coerceFileView = (
  file: { readonly kind: "text" | "external"; readonly name: string },
  view: FileView,
): FileView => {
  if (file.kind === "external" && view === "diff") return "edit";
  if (view === "preview" && !isPreviewableFileName(file.name)) return "edit";
  return view;
};

/**
 * Discriminated by `kind`. `text` is the project-root-relative path the file
 * editor reads via `fs.readFile`; `image` is a raw URL the renderer renders
 * inline (currently used for `zuse://attachments/<id>` so screenshots
 * stay inside the app instead of bouncing to the OS handler).
 */
export type OpenFile =
  | {
      readonly kind: "text";
      readonly folderId: FolderId;
      readonly path: string;
      readonly name: string;
      /**
       * Worktree the file lives in. Persisted on the OpenFile so a save
       * still targets the right tree even if the user switches selected
       * sessions while the file is open. `null` means main checkout.
       */
      readonly worktreeId: WorktreeId | null;
      readonly view: FileView;
    }
  | {
      readonly kind: "image";
      readonly src: string;
      readonly name: string;
    }
  | {
      /**
       * A file outside any project folder (e.g. a plan or markdown file the
       * agent wrote elsewhere on disk). Read/written by absolute path via the
       * `fs.*ExternalFile` RPCs, which deliberately skip the workspace
       * sandbox. External files are edit/preview only — there's no git/folder
       * context for a diff.
       */
      readonly kind: "external";
      readonly absPath: string;
      readonly name: string;
      readonly view: FileView;
    };

export type RevealedAnnotation = CodeAnnotation & {
  /**
   * Monotonic token so clicking the same annotation again still re-scrolls and
   * refreshes the editor highlight.
   */
  readonly revealToken: number;
};

type UiState = {
  readonly view: View;
  readonly setView: (view: View) => void;
  readonly settingsSection: SettingsSection;
  readonly setSettingsSection: (section: SettingsSection) => void;
  readonly activeMainTab: MainTab;
  readonly usageScope: UsageScope;
  readonly openFile: OpenFile | null;
  readonly fileDirty: boolean;
  // 0.02 hard-codes false. The future settings-page autosave toggle flips
  // this to true and a debounced save kicks in inside FileEditor.
  readonly autosave: boolean;
  readonly leftSidebarOpen: boolean;
  /**
   * Transient overlay-reveal of the left sidebar when the docked panel is
   * collapsed. Triggered by hovering the left edge of the window
   * (macOS Dock-style auto-reveal). Resets on reload — never persisted.
   */
  readonly leftSidebarPeek: boolean;
  readonly rightSidebarOpen: boolean;
  /** Whether the cross-project chat quick-switcher (Cmd+K) overlay is open. */
  readonly chatSwitcherOpen: boolean;
  readonly isFullScreen: boolean;
  /** Right-dock tab layout, scoped per sidebar-chat. */
  readonly rightPanelsByChat: Record<string, ReadonlyArray<PanelInstance>>;
  readonly activeRightPanelByChat: Record<string, string | null>;
  readonly revealedAnnotation: RevealedAnnotation | null;
  readonly setActiveMainTab: (tab: MainTab) => void;
  /** Open the Usage dashboard in the main pane at the given scope. */
  readonly openUsage: (scope: UsageScope) => void;
  readonly openFileInTab: (
    file:
      | (Omit<Extract<OpenFile, { kind: "text" }>, "view"> & {
          view?: FileView;
        })
      | (Omit<Extract<OpenFile, { kind: "external" }>, "view"> & {
          view?: FileView;
        })
      | Extract<OpenFile, { kind: "image" }>,
  ) => void;
  readonly setOpenFileView: (view: FileView) => void;
  readonly closeFileTab: () => void;
  readonly setFileDirty: (dirty: boolean) => void;
  readonly setLeftSidebarOpen: (open: boolean) => void;
  readonly setLeftSidebarPeek: (peek: boolean) => void;
  readonly setRightSidebarOpen: (open: boolean) => void;
  readonly setChatSwitcherOpen: (open: boolean) => void;
  readonly toggleChatSwitcher: () => void;
  readonly setFullScreen: (full: boolean) => void;
  /** Add a panel to the dock. Singletons that are already open are focused
   * instead of duplicated; terminals always append a new slot. */
  readonly addPanel: (kind: PanelKind) => void;
  /** Add a terminal panel to a SPECIFIC chat's dock, pinned to a known
   * terminal-list slot (rather than the auto-computed next slot), and activate
   * it. Used to surface a command terminal (e.g. Run) whose instance lives at a
   * known list index — possibly in a chat that isn't currently selected. */
  readonly addTerminalPanelForSlot: (chatId: ChatId, slot: number) => void;
  /** Remove a dock panel by id from the active chat's layout. Layout-only:
   * callers that close a terminal panel must also drop its backing PTY
   * instance (`useTerminalsStore.remove`). Re-indexes remaining terminal
   * slots. */
  readonly closePanel: (id: string) => void;
  readonly setActiveRightPanel: (id: string) => void;
  /** Drop a chat's entire dock layout (on archive/delete). Terminal PTYs are
   * disposed separately via `useTerminalsStore.disposeChat`. */
  readonly clearChatPanels: (chatId: ChatId) => void;
  /** Open the sidebar and ensure a panel of `kind` is present + active.
   * Replaces the old `setRightSidebarOpen(true) + setActiveRightTab(kind)`
   * pairs. For terminals, focuses an existing one or adds a new slot. */
  readonly revealPanel: (kind: PanelKind) => void;
  readonly revealAnnotation: (annotation: CodeAnnotation) => void;
  readonly clearRevealedAnnotation: () => void;
};

const newPanelId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Renumber terminal panels' slots to stay contiguous (0..n-1) in tab order
 * after one is removed, so they keep mapping to the owning chat's terminal
 * list without gaps. */
const reindexTerminalSlots = (
  panels: ReadonlyArray<PanelInstance>,
): ReadonlyArray<PanelInstance> => {
  let next = 0;
  return panels.map((p) =>
    p.kind === "terminal" ? { ...p, slot: next++ } : p,
  );
};

/** Stable empty reference so `rightPanelsByChat[chatId] ?? EMPTY_PANELS`
 * doesn't churn selectors for chats with no dock layout yet. */
export const EMPTY_PANELS: ReadonlyArray<PanelInstance> = [];

/** The chat that owns the dock layout being mutated — always the selected
 * one, since the dock only ever renders/edits the active chat. */
const activeChatId = (): string | null =>
  useChatsStore.getState().selectedChatId;

const writePanels = (
  state: UiState,
  chatId: string,
  panels: ReadonlyArray<PanelInstance>,
  activeId: string | null,
): Pick<UiState, "rightPanelsByChat" | "activeRightPanelByChat"> => ({
  rightPanelsByChat: { ...state.rightPanelsByChat, [chatId]: panels },
  activeRightPanelByChat: {
    ...state.activeRightPanelByChat,
    [chatId]: activeId,
  },
});

export const useUiStore = create<UiState>((set, get) => ({
  view: "chat",
  setView: (view) => set({ view }),
  settingsSection: { kind: "general" },
  setSettingsSection: (section) => set({ settingsSection: section }),
  activeMainTab: "chat",
  usageScope: "global",
  openFile: null,
  fileDirty: false,
  autosave: false,
  leftSidebarOpen: true,
  leftSidebarPeek: false,
  rightSidebarOpen: false,
  chatSwitcherOpen: false,
  isFullScreen: false,
  rightPanelsByChat: {},
  activeRightPanelByChat: {},
  revealedAnnotation: null,
  setActiveMainTab: (tab) => set({ activeMainTab: tab }),
  openUsage: (scope) =>
    set({ view: "chat", activeMainTab: "usage", usageScope: scope }),
  openFileInTab: (file) =>
    set({
      openFile:
        file.kind === "image"
          ? file
          : {
              ...file,
              view: coerceFileView(file, file.view ?? "edit"),
            },
      activeMainTab: "file",
      fileDirty: false,
    }),
  setOpenFileView: (view) =>
    set((s) => {
      if (
        s.openFile === null ||
        (s.openFile.kind !== "text" && s.openFile.kind !== "external")
      ) {
        return s;
      }
      return {
        openFile: { ...s.openFile, view: coerceFileView(s.openFile, view) },
      };
    }),
  closeFileTab: () =>
    set({ openFile: null, activeMainTab: "chat", fileDirty: false }),
  setFileDirty: (dirty) => set({ fileDirty: dirty }),
  // Opening the docked panel implicitly drops any peek state so the overlay
  // doesn't sit on top of the docked panel. Closing it also clears peek so a
  // stale hover doesn't immediately re-reveal the overlay.
  setLeftSidebarOpen: (open) =>
    set({ leftSidebarOpen: open, leftSidebarPeek: false }),
  setLeftSidebarPeek: (peek) => set({ leftSidebarPeek: peek }),
  setRightSidebarOpen: (open) => set({ rightSidebarOpen: open }),
  setChatSwitcherOpen: (open) => set({ chatSwitcherOpen: open }),
  toggleChatSwitcher: () =>
    set((s) => ({ chatSwitcherOpen: !s.chatSwitcherOpen })),
  setFullScreen: (full) => set({ isFullScreen: full }),
  addPanel: (kind) =>
    set((s) => {
      const chatId = activeChatId();
      if (chatId === null) return s;
      const panels = s.rightPanelsByChat[chatId] ?? EMPTY_PANELS;
      if (SINGLETON_PANEL_KINDS.has(kind)) {
        const existing = panels.find((p) => p.kind === kind);
        if (existing !== undefined) {
          return {
            activeRightPanelByChat: {
              ...s.activeRightPanelByChat,
              [chatId]: existing.id,
            },
          };
        }
        const panel = { id: newPanelId(), kind } as PanelInstance;
        return writePanels(s, chatId, [...panels, panel], panel.id);
      }
      // terminal: append a new slot at the next contiguous index.
      const slot = panels.filter((p) => p.kind === "terminal").length;
      const panel: PanelInstance = { id: newPanelId(), kind: "terminal", slot };
      return writePanels(s, chatId, [...panels, panel], panel.id);
    }),
  addTerminalPanelForSlot: (chatId, slot) =>
    set((s) => {
      const panels = s.rightPanelsByChat[chatId] ?? EMPTY_PANELS;
      const panel: PanelInstance = { id: newPanelId(), kind: "terminal", slot };
      return writePanels(s, chatId, [...panels, panel], panel.id);
    }),
  closePanel: (id) =>
    set((s) => {
      const chatId = activeChatId();
      if (chatId === null) return s;
      const panels = s.rightPanelsByChat[chatId] ?? EMPTY_PANELS;
      const idx = panels.findIndex((p) => p.id === id);
      if (idx === -1) return s;
      const next = reindexTerminalSlots(panels.filter((p) => p.id !== id));
      const wasActive = s.activeRightPanelByChat[chatId] === id;
      const activeId = wasActive
        ? (next[Math.max(0, idx - 1)]?.id ?? next[0]?.id ?? null)
        : (s.activeRightPanelByChat[chatId] ?? null);
      return writePanels(s, chatId, next, activeId);
    }),
  setActiveRightPanel: (id) =>
    set((s) => {
      const chatId = activeChatId();
      if (chatId === null) return s;
      return {
        activeRightPanelByChat: { ...s.activeRightPanelByChat, [chatId]: id },
      };
    }),
  clearChatPanels: (chatId) =>
    set((s) => {
      const { [chatId]: _droppedPanels, ...rightPanelsByChat } =
        s.rightPanelsByChat;
      const { [chatId]: _droppedActive, ...activeRightPanelByChat } =
        s.activeRightPanelByChat;
      return { rightPanelsByChat, activeRightPanelByChat };
    }),
  revealPanel: (kind) => {
    const s = get();
    if (!s.rightSidebarOpen) set({ rightSidebarOpen: true });
    const chatId = activeChatId();
    if (chatId === null) return;
    const panels = s.rightPanelsByChat[chatId] ?? EMPTY_PANELS;
    const existing = panels.find((p) => p.kind === kind);
    if (existing !== undefined) {
      set((st) => ({
        activeRightPanelByChat: {
          ...st.activeRightPanelByChat,
          [chatId]: existing.id,
        },
      }));
      return;
    }
    // No panel of this kind yet — add one (terminals add a fresh slot).
    s.addPanel(kind);
  },
  revealAnnotation: (annotation) =>
    set((s) => ({
      revealedAnnotation: {
        ...annotation,
        revealToken: (s.revealedAnnotation?.revealToken ?? 0) + 1,
      },
    })),
  clearRevealedAnnotation: () => set({ revealedAnnotation: null }),
}));
