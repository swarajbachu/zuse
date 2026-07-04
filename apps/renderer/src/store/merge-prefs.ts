import { create } from "zustand";

import type { GitMergeMethod } from "@zuse/wire";

import { readStorageWithLegacy } from "../lib/storage-keys.ts";

/**
 * Local UI preferences for the top-bar Merge button. Purely cosmetic state —
 * which merge method to use and whether to delete the branch on merge — so we
 * keep it in `localStorage` rather than round-tripping `settings.json`.
 *
 * `method` mirrors GitHub's "remember my last choice" behaviour: whatever the
 * user last merged with becomes the default for the next PR.
 */
const STORAGE_KEY = "zuse.mergePrefs.v1";
const LEGACY_STORAGE_KEYS = ["memoize.mergePrefs.v1"] as const;

type Persisted = {
  method: GitMergeMethod;
  deleteBranch: boolean;
};

const DEFAULTS: Persisted = { method: "merge", deleteBranch: false };

const load = (): Persisted => {
  try {
    const raw = readStorageWithLegacy(
      window.localStorage,
      STORAGE_KEY,
      LEGACY_STORAGE_KEYS,
    );
    if (raw === null) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    const method =
      parsed.method === "merge" ||
      parsed.method === "squash" ||
      parsed.method === "rebase"
        ? parsed.method
        : DEFAULTS.method;
    return {
      method,
      deleteBranch: parsed.deleteBranch === true,
    };
  } catch {
    return DEFAULTS;
  }
};

const persist = (state: Persisted): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private-mode / quota errors are non-fatal — the choice just won't stick.
  }
};

type MergePrefsState = Persisted & {
  readonly setMethod: (method: GitMergeMethod) => void;
  readonly setDeleteBranch: (deleteBranch: boolean) => void;
};

export const useMergePrefs = create<MergePrefsState>((set, get) => ({
  ...load(),
  setMethod: (method) => {
    set({ method });
    persist({ method, deleteBranch: get().deleteBranch });
  },
  setDeleteBranch: (deleteBranch) => {
    set({ deleteBranch });
    persist({ method: get().method, deleteBranch });
  },
}));
