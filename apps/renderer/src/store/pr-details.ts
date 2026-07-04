import { Effect } from "effect";
import { create } from "zustand";

import type { FolderId, GitPrDetails, WorktreeId } from "@zuse/wire";

import { getRpcClient } from "../lib/rpc-client.ts";

/**
 * Per-`(folder, worktree)` rich PR detail (title, body, reviews, comments,
 * files, checks). Heavier than {@link usePrStateStore} so we only fetch
 * lazily when the PR pane mounts. Keyed by `(folderId, worktreeId)` because
 * each worktree has its own branch and therefore its own PR.
 */
type PrDetailsMap = Record<string, GitPrDetails>;

type PrDetailsState = {
  readonly byKey: PrDetailsMap;
  readonly loadingByKey: Record<string, boolean>;
  readonly hydrate: (
    folderId: FolderId,
    worktreeId?: WorktreeId | null,
  ) => Promise<void>;
  readonly refresh: (
    folderId: FolderId,
    worktreeId?: WorktreeId | null,
  ) => Promise<void>;
};

export const prDetailsKey = (
  folderId: FolderId,
  worktreeId: WorktreeId | null | undefined,
): string => `${folderId}:${worktreeId ?? "main"}`;

const fetchPrDetails = async (
  folderId: FolderId,
  worktreeId: WorktreeId | null | undefined,
): Promise<GitPrDetails | null> => {
  try {
    const client = await getRpcClient();
    return await Effect.runPromise(
      client.git.prDetails({ folderId, worktreeId: worktreeId ?? null }),
    );
  } catch {
    return null;
  }
};

export const usePrDetailsStore = create<PrDetailsState>((set, get) => ({
  byKey: {},
  loadingByKey: {},
  hydrate: async (folderId, worktreeId) => {
    const key = prDetailsKey(folderId, worktreeId);
    if (key in get().byKey) return;
    if (get().loadingByKey[key] === true) return;
    set((s) => ({ loadingByKey: { ...s.loadingByKey, [key]: true } }));
    const info = await fetchPrDetails(folderId, worktreeId);
    set((s) => ({
      loadingByKey: { ...s.loadingByKey, [key]: false },
      byKey: info === null ? s.byKey : { ...s.byKey, [key]: info },
    }));
  },
  refresh: async (folderId, worktreeId) => {
    const info = await fetchPrDetails(folderId, worktreeId);
    if (info === null) return;
    const key = prDetailsKey(folderId, worktreeId);
    set((s) => ({ byKey: { ...s.byKey, [key]: info } }));
  },
}));
