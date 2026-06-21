import { useMemo } from "react";

import type { FolderId, SessionId, WorktreeId } from "@memoize/wire";

import { useSessionsStore } from "./sessions.ts";
import { useWorkspaceStore } from "./workspace.ts";
import { EMPTY_WORKTREES, useWorktreesStore } from "./worktrees.ts";

/**
 * Canonical "where am I" signal for the renderer. Every surface that needs
 * to know the current project, session, worktree, or root path — terminal,
 * file tree, chat composer, top bar, git status — reads from
 * `useActiveContext()` so they can never disagree.
 *
 * Before this hook existed, each surface independently called
 * `useActiveWorkspaceRoot(folderId)` with a different `folderId` source
 * (terminal: `selectedFolderId`, composer: `session.projectId`, top-bar:
 * prop), and the underlying selector silently fell back to `folder.path`
 * when the worktree row wasn't hydrated yet — so the terminal could mount
 * a PTY in the wrong directory with no signal to the user. The
 * `worktreePending` flag in the `ready` variant makes that race explicit.
 */
export type ActiveContext =
  /** Folders RPC hasn't resolved yet on cold start. */
  | { readonly status: "loading" }
  /** Folders loaded, but none selected (empty workspace or after remove). */
  | { readonly status: "empty" }
  | {
      readonly status: "ready";
      readonly folderId: FolderId;
      readonly folderPath: string;
      readonly sessionId: SessionId | null;
      /**
       * The worktree the session has bound. `null` when the session runs in
       * the main checkout — or when no session is selected for this project.
       */
      readonly worktreeId: WorktreeId | null;
      /**
       * The path consumers should open files / PTYs / git ops in. Equals
       * the worktree's path when one is bound and hydrated, otherwise the
       * folder's path. **Never** silently falls back to the folder when a
       * worktree is bound — see `worktreePending`.
       */
      readonly rootPath: string;
      readonly rootKind: "folder" | "worktree";
      /**
       * `true` when the session names a worktreeId but `worktrees.byProject`
       * doesn't have its row yet. Consumers that would mount a PTY or open
       * a file in the resolved path should wait (render a placeholder)
       * instead of using `rootPath` — `rootPath` is `folderPath` in this
       * state, which is **not** where the user wants to operate.
       */
      readonly worktreePending: boolean;
    };

/**
 * Returns the canonical active context. Recomputed on the minimal set of
 * store-slot changes. Memoized so consumers can pass the object to React
 * dependency arrays without re-firing on unrelated store updates.
 */
export const useActiveContext = (): ActiveContext => {
  const foldersLoaded = useWorkspaceStore(
    (s) => !s.loading || s.folders.length > 0,
  );
  const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
  const folderPath = useWorkspaceStore((s) => {
    if (s.selectedFolderId === null) return null;
    return s.folders.find((f) => f.id === s.selectedFolderId)?.path ?? null;
  });
  const sessionId = useSessionsStore((s) =>
    selectedFolderId !== null
      ? (s.selectedSessionByProject[selectedFolderId] ?? null)
      : null,
  );
  const sessionWorktreeId = useSessionsStore((s) => {
    if (selectedFolderId === null || sessionId === null) return null;
    const list = s.sessionsByProject[selectedFolderId] ?? null;
    if (list === null) return null;
    return list.find((sess) => sess.id === sessionId)?.worktreeId ?? null;
  });
  const worktreePath = useWorktreesStore((s) => {
    if (selectedFolderId === null || sessionWorktreeId === null) return null;
    const list = s.byProject[selectedFolderId] ?? EMPTY_WORKTREES;
    return list.find((w) => w.id === sessionWorktreeId)?.path ?? null;
  });

  return useMemo<ActiveContext>(() => {
    if (!foldersLoaded) return { status: "loading" };
    if (selectedFolderId === null || folderPath === null) {
      return { status: "empty" };
    }
    if (sessionWorktreeId !== null && worktreePath !== null) {
      return {
        status: "ready",
        folderId: selectedFolderId,
        folderPath,
        sessionId,
        worktreeId: sessionWorktreeId,
        rootPath: worktreePath,
        rootKind: "worktree",
        worktreePending: false,
      };
    }
    if (sessionWorktreeId !== null && worktreePath === null) {
      // Session is bound to a worktree we haven't hydrated yet. Surface this
      // explicitly — do NOT silently fall back to folderPath.
      return {
        status: "ready",
        folderId: selectedFolderId,
        folderPath,
        sessionId,
        worktreeId: sessionWorktreeId,
        rootPath: folderPath,
        rootKind: "folder",
        worktreePending: true,
      };
    }
    return {
      status: "ready",
      folderId: selectedFolderId,
      folderPath,
      sessionId,
      worktreeId: null,
      rootPath: folderPath,
      rootKind: "folder",
      worktreePending: false,
    };
  }, [
    foldersLoaded,
    selectedFolderId,
    folderPath,
    sessionId,
    sessionWorktreeId,
    worktreePath,
  ]);
};

/**
 * Per-project lookup of the active session's worktree. Kept for callers
 * that legitimately scope to a specific project id (the chat composer's
 * FileTagPopover, which resolves file mentions under the session's own
 * project even if the user has briefly glanced at another). For surfaces
 * that should follow the user's current selection, prefer
 * `useActiveContext()` — it can never disagree with itself across panels.
 */
export const useActiveWorktreeId = (
  folderId: FolderId | null,
): WorktreeId | null => {
  const sessionId = useSessionsStore((s) =>
    folderId !== null ? (s.selectedSessionByProject[folderId] ?? null) : null,
  );
  const sessions = useSessionsStore((s) =>
    folderId !== null ? (s.sessionsByProject[folderId] ?? null) : null,
  );
  if (sessionId === null || sessions === null) return null;
  const found = sessions.find((sess) => sess.id === sessionId);
  return found?.worktreeId ?? null;
};

/**
 * Per-project active root path. See `useActiveWorktreeId` for when to
 * pick this over `useActiveContext()`. Note: this preserves the legacy
 * "silent fallback to folder.path when worktree not yet hydrated"
 * behavior — call `useActiveContext()` if you need to distinguish that
 * race from a deliberate main-checkout session.
 */
export const useActiveWorkspaceRoot = (
  folderId: FolderId | null,
): string | null => {
  const folder = useWorkspaceStore((s) =>
    folderId === null
      ? null
      : (s.folders.find((f) => f.id === folderId) ?? null),
  );
  const worktreeId = useActiveWorktreeId(folderId);
  const worktree = useWorktreesStore((s) => {
    if (folderId === null || worktreeId === null) return null;
    const list = s.byProject[folderId] ?? [];
    return list.find((w) => w.id === worktreeId) ?? null;
  });
  if (folder === null) return null;
  if (worktreeId === null || worktree === null) return folder.path;
  return worktree.path;
};
