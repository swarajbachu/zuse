import { Effect } from "effect";
import { create } from "zustand";

import type { FolderId, WorktreeId } from "@zuse/contracts";

import { getRpcClient } from "../lib/rpc-client.ts";

/**
 * Per-branch diff-stat cache: total additions/deletions of a worktree's
 * branch (including uncommitted edits) vs the repo's base branch. Source of
 * truth for the projects sidebar's `+N −N` slot, which shows a branch's diff
 * even before a PR exists. Keyed by `(folderId, worktreeId)` because each
 * worktree owns its own branch. Hydrated lazily when a chat row mounts and
 * refreshed alongside `git.changes` after commits/reverts.
 */
export type GitDiffStat = { readonly additions: number; readonly deletions: number };

type DiffStatMap = Record<string, GitDiffStat>;

type DiffStatState = {
  readonly byKey: DiffStatMap;
  readonly hydrate: (
    folderId: FolderId,
    worktreeId?: WorktreeId | null,
  ) => Promise<void>;
  readonly refresh: (
    folderId: FolderId,
    worktreeId?: WorktreeId | null,
  ) => Promise<void>;
};

export const gitDiffStatKey = (
  folderId: FolderId,
  worktreeId: WorktreeId | null | undefined,
): string => `${folderId}:${worktreeId ?? "main"}`;

const fetchDiffStat = async (
  folderId: FolderId,
  worktreeId: WorktreeId | null | undefined,
): Promise<GitDiffStat | null> => {
  try {
    const client = await getRpcClient();
    return await Effect.runPromise(
      client.git.diffStat({ folderId, worktreeId: worktreeId ?? null }),
    );
  } catch {
    // Not a repo, git missing, etc. — caller treats absence as "no stats".
    return null;
  }
};

export const useGitDiffStatStore = create<DiffStatState>((set, get) => ({
  byKey: {},
  hydrate: async (folderId, worktreeId) => {
    const key = gitDiffStatKey(folderId, worktreeId);
    if (key in get().byKey) return;
    const stat = await fetchDiffStat(folderId, worktreeId);
    if (stat === null) return;
    set((s) => ({ byKey: { ...s.byKey, [key]: stat } }));
  },
  refresh: async (folderId, worktreeId) => {
    const stat = await fetchDiffStat(folderId, worktreeId);
    if (stat === null) return;
    const key = gitDiffStatKey(folderId, worktreeId);
    set((s) => ({ byKey: { ...s.byKey, [key]: stat } }));
  },
}));
