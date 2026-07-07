import { create } from "zustand";

import type { FolderId, GitStatusSummary, WorktreeId } from "@zuse/wire";

import { classifyGit } from "../lib/git-rpc.ts";
import { getRpcClient } from "../lib/rpc-client.ts";

/**
 * `git status` summary used by the top bar to decide which workflow button
 * to surface (Commit & push / Create PR / View PR). Refresh is driven by
 * the server's `git.worktreeChanged` stream (sub-second after any FS
 * change) with a 30s poll as a backstop for filesystems where `fs.watch`
 * is unreliable. The subscription is opened in `top-bar.tsx`.
 *
 * Keyed by `(folderId, worktreeId)` because a session running in a worktree
 * has its own branch + dirty state that differs from the main checkout.
 * Use `gitStatusKey` to compute the lookup key on both sides.
 */
type StatusMap = Record<string, GitStatusSummary>;

type GitStatusState = {
  readonly byKey: StatusMap;
  // True when the last fetch failed with `GitNotARepoError` — lets consumers
  // (e.g. the PR tab) distinguish "this folder has no repo" from "status
  // hasn't loaded yet", since both leave `byKey` empty.
  readonly noRepoByKey: Record<string, boolean>;
  readonly refresh: (
    folderId: FolderId,
    worktreeId?: WorktreeId | null,
  ) => Promise<void>;
};

export const gitStatusKey = (
  folderId: FolderId,
  worktreeId: WorktreeId | null | undefined,
): string => `${folderId}:${worktreeId ?? "main"}`;

export const useGitStatusStore = create<GitStatusState>((set) => ({
  byKey: {},
  noRepoByKey: {},
  refresh: async (folderId, worktreeId) => {
    const key = gitStatusKey(folderId, worktreeId);
    const client = await getRpcClient();
    const result = await classifyGit(
      client.git.status({ folderId, worktreeId: worktreeId ?? null }),
    );
    set((s) => ({
      byKey: result.ok ? { ...s.byKey, [key]: result.value } : s.byKey,
      noRepoByKey: {
        ...s.noRepoByKey,
        [key]: !result.ok && result.tag === "GitNotARepoError",
      },
    }));
  },
}));
