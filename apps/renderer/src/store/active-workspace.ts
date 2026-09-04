import {
	EnvironmentId,
	type FolderId,
	type SessionId,
	type WorktreeId,
} from "@zuse/contracts";
import { useEffect, useMemo } from "react";
import { useCloudChatSummaryForSelection } from "../lib/cloud-workspaces.ts";
import { useActiveEnvironmentEntities } from "../lib/environment-entity-hooks.ts";
import { useEnvironmentShellResource } from "../lib/environment-shell-client-bus.ts";
import { useChatsStore } from "./chats.ts";
import { useEnvironmentCatalogStore } from "./environment-catalog.ts";
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
			readonly status: "cloud-unavailable";
			readonly workspaceId: string;
			readonly projectId: FolderId;
			readonly sessionId: SessionId;
			readonly attachmentState: "detached" | "attaching" | "failed";
	  }
	| {
			readonly status: "worktree-pending";
			readonly environmentId: EnvironmentId;
			readonly folderId: FolderId;
			readonly folderPath: string;
			readonly sessionId: SessionId;
			readonly worktreeId: WorktreeId | null;
	  }
	| {
			readonly status: "ready";
			readonly environmentId: EnvironmentId;
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
	const activeEnvironmentId = useEnvironmentCatalogStore(
		(state) => state.activeEnvironmentId,
	);
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
	const selectedChatId = useChatsStore((state) => state.selectedChatId);
	const cloudSummary = useCloudChatSummaryForSelection({
		chatId: selectedChatId,
		sessionId,
	});
	const pendingCreation = useChatsStore((state) => {
		const chatId = state.selectedChatId;
		return chatId === null
			? null
			: (state.pendingCreationByChat[chatId] ?? null);
	});
	const { sessionsByProject } = useActiveEnvironmentEntities();
	const sessionWorktreeId =
		selectedFolderId === null || sessionId === null
			? null
			: (sessionsByProject[selectedFolderId]?.find(
					(sess) => sess.id === sessionId,
				)?.worktreeId ?? null);
	const activeWorktreeId = pendingCreation?.workspaceRequested
		? (pendingCreation.worktreeId ?? sessionWorktreeId)
		: sessionWorktreeId;
	const worktreePath = useWorktreesStore((s) => {
		if (selectedFolderId === null || activeWorktreeId === null) return null;
		const list = s.byProject[selectedFolderId] ?? EMPTY_WORKTREES;
		return list.find((w) => w.id === activeWorktreeId)?.path ?? null;
	});
	const refreshWorktrees = useWorktreesStore((s) => s.refresh);
	useEffect(() => {
		if (
			selectedFolderId === null ||
			activeWorktreeId === null ||
			worktreePath !== null
		)
			return;
		// A session and its worktree are committed by the same server command, but
		// their renderer projections are hydrated independently. Reconcile the
		// worktree row as soon as the selected session names it so the canonical
		// context cannot remain stuck in `worktree-pending` after creation settles.
		void refreshWorktrees(selectedFolderId);
	}, [selectedFolderId, activeWorktreeId, worktreePath, refreshWorktrees]);
	const cloudWorkspaceId = cloudSummary?.workspaceId ?? null;
	const cloudShell = useEnvironmentShellResource(
		cloudWorkspaceId === null ? null : EnvironmentId.make(cloudWorkspaceId),
		cloudWorkspaceId === null ? "cache-only" : "connect",
	);
	const cloudFolder = cloudShell.data?.folders[0] ?? null;

	return useMemo<ActiveContext>(() => {
		if (!foldersLoaded) return { status: "loading" };
		if (selectedFolderId === null || folderPath === null) {
			return { status: "empty" };
		}
		if (
			cloudWorkspaceId !== null &&
			cloudFolder === null &&
			sessionId !== null
		) {
			return {
				status: "cloud-unavailable",
				workspaceId: cloudWorkspaceId,
				projectId: selectedFolderId,
				sessionId,
				attachmentState:
					cloudShell.connection === "waking" ||
					cloudShell.connection === "connecting" ||
					cloudShell.connection === "reconnecting"
						? "attaching"
						: cloudShell.connection === "failed" ||
								cloudShell.connection === "blocked-auth" ||
								cloudShell.connection === "update-required" ||
								cloudShell.connection === "revoked"
							? "failed"
							: "detached",
			};
		}
		if (cloudFolder !== null) {
			return {
				status: "ready",
				environmentId: EnvironmentId.make(
					cloudWorkspaceId ?? activeEnvironmentId,
				),
				folderId: cloudFolder.id,
				folderPath: cloudFolder.path,
				sessionId,
				worktreeId: null,
				rootPath: cloudFolder.path,
				rootKind: "folder",
				worktreePending: false,
			};
		}
		if (
			pendingCreation?.workspaceRequested &&
			pendingCreation.projectId === selectedFolderId &&
			(activeWorktreeId === null || worktreePath === null)
		) {
			return {
				status: "worktree-pending",
				environmentId: EnvironmentId.make(activeEnvironmentId),
				folderId: selectedFolderId,
				folderPath,
				sessionId: pendingCreation.sessionId,
				worktreeId: pendingCreation.worktreeId,
			};
		}
		if (activeWorktreeId !== null && worktreePath !== null) {
			return {
				status: "ready",
				environmentId: EnvironmentId.make(activeEnvironmentId),
				folderId: selectedFolderId,
				folderPath,
				sessionId,
				worktreeId: activeWorktreeId,
				rootPath: worktreePath,
				rootKind: "worktree",
				worktreePending: false,
			};
		}
		if (
			activeWorktreeId !== null &&
			worktreePath === null &&
			sessionId !== null
		) {
			// Session is bound to a worktree we haven't hydrated yet. This is not a
			// usable ExecutionRef: exposing folderPath here lets files/Git/terminals
			// silently mount against the main checkout.
			return {
				status: "worktree-pending",
				environmentId: EnvironmentId.make(activeEnvironmentId),
				folderId: selectedFolderId,
				folderPath,
				sessionId,
				worktreeId: activeWorktreeId,
			};
		}
		return {
			status: "ready",
			environmentId: EnvironmentId.make(activeEnvironmentId),
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
		activeWorktreeId,
		worktreePath,
		cloudWorkspaceId,
		cloudShell.connection,
		cloudFolder,
		activeEnvironmentId,
		pendingCreation,
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
	const { sessionsByProject } = useActiveEnvironmentEntities();
	const sessions =
		folderId !== null ? (sessionsByProject[folderId] ?? null) : null;
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
