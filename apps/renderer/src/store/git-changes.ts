import { Effect } from "effect";
import { create } from "zustand";

import type { FolderId, GitChange, WorktreeId } from "@zuse/contracts";

import { classifyGit, type GitErrorTag } from "../lib/git-rpc.ts";
import { getRpcClient } from "../lib/rpc-client.ts";
import { useGitDiffStatStore } from "./git-diff-stat.ts";
import { useGitStatusStore } from "./git-status.ts";
import { usePrDetailsStore } from "./pr-details.ts";
import { usePrStateStore } from "./pr-state.ts";

/**
 * Per-`(folder, worktree)` list of working-tree changes parsed from
 * `git status --porcelain=v2`. Backs the Changes tab's "tracked / untracked"
 * sections. Polled on the same 5s cadence the top bar uses for `git.status`.
 */
type ChangesMap = Record<string, ReadonlyArray<GitChange>>;

type GitChangesState = {
  readonly byKey: ChangesMap;
  readonly loadingByKey: Record<string, boolean>;
  readonly errorByKey: Record<string, string | null>;
  // The error's `_tag` (e.g. "GitNotARepoError"), kept distinct from the
  // human-readable message so the Changes tab can branch on it — most notably
  // to swap the raw error for an "Initialize Git" CTA when there's no repo.
  readonly errorTagByKey: Record<string, GitErrorTag | null>;
  readonly refresh: (
    folderId: FolderId,
    worktreeId?: WorktreeId | null,
  ) => Promise<void>;
  // Initialize a git repo in the folder, then refresh this store plus the
  // git-status / PR stores so every tab flips out of its "no repo" state at
  // once instead of waiting for the next 5s poll.
  readonly initRepo: (
    folderId: FolderId,
    worktreeId?: WorktreeId | null,
  ) => Promise<void>;
};

export const gitChangesKey = (
  folderId: FolderId,
  worktreeId: WorktreeId | null | undefined,
): string => `${folderId}:${worktreeId ?? "main"}`;

export const useGitChangesStore = create<GitChangesState>((set, get) => ({
  byKey: {},
  loadingByKey: {},
  errorByKey: {},
  errorTagByKey: {},
  refresh: async (folderId, worktreeId) => {
    const key = gitChangesKey(folderId, worktreeId);
    const client = await getRpcClient();
    const result = await classifyGit(
      client["git.changes"]({ folderId, worktreeId: worktreeId ?? null }),
    );
    set((s) => ({
      byKey: result.ok ? { ...s.byKey, [key]: result.value } : s.byKey,
      errorByKey: { ...s.errorByKey, [key]: result.ok ? null : result.message },
      errorTagByKey: {
        ...s.errorTagByKey,
        [key]: result.ok ? null : result.tag,
      },
      loadingByKey: { ...s.loadingByKey, [key]: false },
    }));
    // Keep the sidebar's per-branch +/- in sync with the working tree.
    void useGitDiffStatStore.getState().refresh(folderId, worktreeId);
  },
  initRepo: async (folderId, worktreeId) => {
    const client = await getRpcClient();
    await Effect.runPromise(client["git.init"]({ folderId }));
    await Promise.all([
      get().refresh(folderId, worktreeId),
      useGitStatusStore.getState().refresh(folderId, worktreeId),
      usePrStateStore.getState().refresh(folderId, worktreeId),
      usePrDetailsStore.getState().refresh(folderId, worktreeId),
    ]);
  },
}));
