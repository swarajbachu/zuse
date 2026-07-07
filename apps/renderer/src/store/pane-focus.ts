import { useEffect } from "react";
import type { RefObject } from "react";
import { create } from "zustand";

/**
 * The four keyboard-navigable regions of the workbench, in Tab-walk order.
 * `focus-next-pane` / `focus-prev-pane` cycle through whichever of these are
 * currently mounted. Mirrors the lightweight callback-registry pattern of
 * `composer-bridge.ts` rather than threading refs through the layout tree.
 */
export type PaneId = "sidebar" | "chat" | "composer" | "rightPane";

const ORDER: ReadonlyArray<PaneId> = [
  "sidebar",
  "chat",
  "composer",
  "rightPane",
];

type Focuser = () => void;

type PaneFocusState = {
  readonly focusers: Partial<Record<PaneId, Focuser>>;
  readonly register: (pane: PaneId, fn: Focuser) => void;
  readonly unregister: (pane: PaneId) => void;
  /**
   * Move focus to the pane after (`+1`) or before (`-1`) the one the user is
   * currently in. The current pane is read from the DOM (`activeElement`'s
   * nearest `[data-pane]` ancestor), so it stays correct whether focus got
   * there by click or by a prior keyboard hop. Only mounted panes participate;
   * the walk wraps around.
   */
  readonly focusAdjacent: (dir: 1 | -1) => void;
};

export const usePaneFocus = create<PaneFocusState>((set, get) => ({
  focusers: {},
  register: (pane, fn) =>
    set((s) => ({ focusers: { ...s.focusers, [pane]: fn } })),
  unregister: (pane) =>
    set((s) => {
      if (s.focusers[pane] === undefined) return s;
      const next = { ...s.focusers };
      delete next[pane];
      return { focusers: next };
    }),
  focusAdjacent: (dir) => {
    const { focusers } = get();
    const available = ORDER.filter((p) => focusers[p] !== undefined);
    if (available.length === 0) return;

    const active =
      typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null;
    const container = active?.closest?.("[data-pane]") as HTMLElement | null;
    const currentPane = container?.dataset.pane as PaneId | undefined;
    const curIdx =
      currentPane !== undefined ? available.indexOf(currentPane) : -1;

    // Unknown current pane → land on the first pane when going forward, the
    // last when going backward.
    const base = curIdx === -1 ? (dir === 1 ? -1 : 0) : curIdx;
    const nextIdx = (base + dir + available.length) % available.length;
    focusers[available[nextIdx]!]?.();
  },
}));

/**
 * Register `pane`'s focuser as the element behind `ref` for the lifetime of
 * the calling component. The element should carry `data-pane={pane}` and a
 * `tabIndex={-1}` so it can receive programmatic focus.
 */
export function useRegisterPane<T extends HTMLElement>(
  pane: PaneId,
  ref: RefObject<T | null>,
): void {
  useEffect(() => {
    usePaneFocus.getState().register(pane, () => ref.current?.focus());
    return () => usePaneFocus.getState().unregister(pane);
  }, [pane, ref]);
}
