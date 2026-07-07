import { create } from "zustand";

import type { ChatId } from "@zuse/wire";

import * as terminalRegistry from "../lib/terminal-registry.ts";

/**
 * Renderer-side terminal instances. The xterm + PTY themselves live in
 * `terminal-registry.ts` (kept alive across chat switches); this store only
 * tracks the list of slots each chat wants to see and which one is focused.
 * PTYs die with the renderer (no rehydration across reloads).
 *
 * Keyed by `chatId` so each sidebar chat gets its own terminal list — opening
 * a shell in one chat doesn't show up in (or get torn down by switching to)
 * another. Closing a terminal, or its owning chat, disposes the backing PTY
 * via the registry (`remove` / `disposeChat`).
 */
export type TerminalInstance = {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly command?: {
    readonly cmd: string;
    readonly args: ReadonlyArray<string>;
    readonly env?: Readonly<Record<string, string>>;
  };
};

type TerminalsState = {
  readonly byKey: Readonly<Record<string, ReadonlyArray<TerminalInstance>>>;
  readonly activeByKey: Readonly<Record<string, string | null>>;
  readonly ensureSeed: (key: string, cwd: string) => void;
  /**
   * Resolve a 0-based slot index to a terminal instance for `key`, appending
   * fresh instances until the list is long enough. Used by the right-dock
   * terminal tabs, which carry a workspace-relative `slot` rather than a
   * pinned instance id (see `ui.ts` PanelInstance). Returns the instance at
   * `slot`.
   */
  readonly ensureSlot: (
    key: string,
    slot: number,
    cwd: string,
  ) => TerminalInstance;
  readonly add: (key: string, cwd: string) => string;
  /**
   * Append a command-bound terminal instance and return its 0-based LIST
   * INDEX (not its id), so the caller can pin a right-dock terminal panel to
   * exactly that slot (see `lib/run-terminal.ts`).
   */
  readonly addCommand: (
    key: string,
    cwd: string,
    title: string,
    command: TerminalInstance["command"],
  ) => number;
  readonly remove: (key: string, id: string) => void;
  readonly setActive: (key: string, id: string) => void;
  /**
   * Dispose every terminal owned by a chat (closing each backing PTY) and drop
   * the chat's list. Called when a chat is archived or deleted so its shells
   * don't leak.
   */
  readonly disposeChat: (chatId: ChatId) => void;
};

export const terminalsKey = (chatId: ChatId): string => chatId;

const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const nextTitle = (existing: ReadonlyArray<TerminalInstance>): string => {
  if (existing.length === 0) return "zsh";
  // "zsh", "zsh 2", "zsh 3" — skip numbers already in use so closing the
  // middle one and adding again reuses the gap rather than racing past it.
  const used = new Set(existing.map((t) => t.title));
  for (let n = 2; n < 1000; n++) {
    const candidate = `zsh ${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `zsh ${existing.length + 1}`;
};

export const useTerminalsStore = create<TerminalsState>((set) => ({
  byKey: {},
  activeByKey: {},
  ensureSeed: (key, cwd) =>
    set((state) => {
      if ((state.byKey[key]?.length ?? 0) > 0) return state;
      const instance: TerminalInstance = { id: newId(), title: "zsh", cwd };
      return {
        byKey: { ...state.byKey, [key]: [instance] },
        activeByKey: { ...state.activeByKey, [key]: instance.id },
      };
    }),
  ensureSlot: (key, slot, cwd) => {
    let result: TerminalInstance | undefined;
    set((state) => {
      const list = state.byKey[key] ?? [];
      if (list.length > slot) {
        result = list[slot];
        return state;
      }
      const next = [...list];
      while (next.length <= slot) {
        next.push({ id: newId(), title: nextTitle(next), cwd });
      }
      const instance = next[slot] as TerminalInstance;
      result = instance;
      // Only claim focus when the key has none yet — the dock renders each
      // slot independently, so `activeByKey` is only meaningful to the
      // worktree `TerminalWorkspace` list path.
      const active = state.activeByKey[key] ?? instance.id;
      return {
        byKey: { ...state.byKey, [key]: next },
        activeByKey: { ...state.activeByKey, [key]: active },
      };
    });
    return result as TerminalInstance;
  },
  add: (key, cwd) => {
    const id = newId();
    set((state) => {
      const list = state.byKey[key] ?? [];
      const instance: TerminalInstance = { id, title: nextTitle(list), cwd };
      return {
        byKey: { ...state.byKey, [key]: [...list, instance] },
        activeByKey: { ...state.activeByKey, [key]: id },
      };
    });
    return id;
  },
  addCommand: (key, cwd, title, command) => {
    const id = newId();
    let index = 0;
    set((state) => {
      const list = state.byKey[key] ?? [];
      index = list.length;
      const instance: TerminalInstance = { id, title, cwd, command };
      return {
        byKey: { ...state.byKey, [key]: [...list, instance] },
        activeByKey: { ...state.activeByKey, [key]: id },
      };
    });
    return index;
  },
  remove: (key, id) =>
    set((state) => {
      const list = state.byKey[key] ?? [];
      const idx = list.findIndex((t) => t.id === id);
      if (idx === -1) return state;
      // Component unmount no longer kills the PTY (it only detaches), so an
      // explicit close has to tear the backing shell down here.
      terminalRegistry.dispose(id);
      const next = list.filter((t) => t.id !== id);
      const wasActive = state.activeByKey[key] === id;
      // Pick the previous instance when closing the active one; if that
      // doesn't exist, fall back to whatever now sits in the same slot.
      const fallback = wasActive
        ? (next[Math.max(0, idx - 1)]?.id ?? null)
        : (state.activeByKey[key] ?? null);
      return {
        byKey: { ...state.byKey, [key]: next },
        activeByKey: { ...state.activeByKey, [key]: fallback },
      };
    }),
  setActive: (key, id) =>
    set((state) => ({
      activeByKey: { ...state.activeByKey, [key]: id },
    })),
  disposeChat: (chatId) =>
    set((state) => {
      const key = terminalsKey(chatId);
      const list = state.byKey[key];
      if (list === undefined) return state;
      for (const inst of list) terminalRegistry.dispose(inst.id);
      const { [key]: _droppedList, ...byKey } = state.byKey;
      const { [key]: _droppedActive, ...activeByKey } = state.activeByKey;
      return { byKey, activeByKey };
    }),
}));

export const EMPTY_TERMINALS: ReadonlyArray<TerminalInstance> = [];
