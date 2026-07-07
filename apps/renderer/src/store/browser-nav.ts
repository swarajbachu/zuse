import { create } from "zustand";

/**
 * Programmatic navigation into the browser pane. The pane's URL is local
 * state (`browser-pane.tsx`); this store is the one-way mailbox other
 * features (deploy URL chip, agent flows) drop a URL into. `token` bumps on
 * every request so navigating to the same URL twice still fires the pane's
 * effect.
 */
type BrowserNavState = {
  readonly pendingNavigation: { readonly url: string; readonly token: number } | null;
  readonly navigateTo: (url: string) => void;
  readonly consume: () => void;
};

export const useBrowserNavStore = create<BrowserNavState>((set) => ({
  pendingNavigation: null,
  navigateTo: (url) =>
    set((s) => ({
      pendingNavigation: { url, token: (s.pendingNavigation?.token ?? 0) + 1 },
    })),
  consume: () => set({ pendingNavigation: null }),
}));
