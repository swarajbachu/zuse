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
 * `worktree-pending` variant makes that race explicit.
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
			readonly sessionId: SessionId | null;
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
			 * worktree is bound — unresolved bindings use `worktree-pending`.
			 */
			readonly rootPath: string;
			readonly rootKind: "folder" | "worktree";
			/** Compatibility flag; unresolved worktrees use the pending variant. */
			readonly worktreePending: boolean;
	  };

const useSelectedWorkspaceBinding = (folderId: FolderId | null) => {
	const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
	// The current panels must follow the same session selection as the transcript.
	// The per-project slot is navigation history and can lag a newly selected tab.
	const sessionId = useSessionsStore((s) =>
		folderId === null
			? null
			: folderId === selectedFolderId
				? s.selectedSessionId
				: (s.selectedSessionByProject[folderId] ?? null),
	);
	const selectedChatId = useChatsStore((s) =>
		folderId === null
			? null
			: folderId === selectedFolderId
				? s.selectedChatId
				: (s.selectedChatByProject[folderId] ?? null),
	);
	const pendingCreation = useChatsStore((s) =>
		selectedChatId === null
			? null
			: (s.pendingCreationByChat[selectedChatId] ?? null),
	);
	const { sessionsByProject, chatsByProject, creationOperationsByProject } =
		useActiveEnvironmentEntities();
	const session =
		folderId === null
			? null
			: sessionsByProject[folderId]?.find((row) => row.id === sessionId);
	const chat =
		folderId === null
			? null
			: chatsByProject[folderId]?.find(
					(row) => row.id === (selectedChatId ?? session?.chatId),
				);
	// Keep the completed reservation until entity summaries catch up. A later
	// explicit chat binding supersedes it, including a switch to main.
	const creation =
		folderId === null
			? null
			: creationOperationsByProject[folderId]?.find(
					(row) =>
						row.chatId === (chat?.id ?? selectedChatId) &&
						row.phase !== "cancelled" &&
						(row.phase !== "running" ||
							chat == null ||
							row.updatedAt.getTime() >= chat.updatedAt.getTime()),
				);
	const pending =
		pendingCreation?.projectId === folderId ? pendingCreation : null;
	// The chat owns the binding. Its session summary and creation receipt can
	// arrive independently; neither may erase a newer durable workspace intent.
	const selectedSession =
		selectedChatId === null || session?.chatId === selectedChatId
			? session
			: null;
	const worktreeId =
		chat?.worktreeId ??
		selectedSession?.worktreeId ??
		creation?.worktreeId ??
		pending?.worktreeId ??
		null;
	const workspaceRequested =
		worktreeId !== null ||
		(creation != null && creation.workspacePolicy._tag !== "main") ||
		pending?.workspaceRequested === true ||
		// Missing summaries do not establish that a selected chat uses main.
		// Opening a PTY here would permanently pin that terminal to the wrong cwd.
		(chat == null &&
			selectedSession == null &&
			(selectedChatId !== null || sessionId !== null));
	return { sessionId, selectedChatId, worktreeId, workspaceRequested };
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
	const {
		sessionId,
		selectedChatId,
		worktreeId: activeWorktreeId,
		workspaceRequested,
	} = useSelectedWorkspaceBinding(selectedFolderId);
	const cloudSummary = useCloudChatSummaryForSelection({
		chatId: selectedChatId,
		sessionId,
	});
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
			workspaceRequested &&
			(activeWorktreeId === null || worktreePath === null)
		) {
			return {
				status: "worktree-pending",
				environmentId: EnvironmentId.make(activeEnvironmentId),
				folderId: selectedFolderId,
				folderPath,
				sessionId,
				worktreeId: activeWorktreeId,
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
		workspaceRequested,
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
	return useSelectedWorkspaceBinding(folderId).worktreeId;
};

/**
 * Per-project active root path. See `useActiveWorktreeId` for when to
 * pick this over `useActiveContext()`. Returns null until a requested worktree
 * is hydrated, so file mentions cannot target the main checkout during setup.
 */
export const useActiveWorkspaceRoot = (
	folderId: FolderId | null,
): string | null => {
	const folder = useWorkspaceStore((s) =>
		folderId === null
			? null
			: (s.folders.find((f) => f.id === folderId) ?? null),
	);
	const { worktreeId, workspaceRequested } =
		useSelectedWorkspaceBinding(folderId);
	const worktree = useWorktreesStore((s) => {
		if (folderId === null || worktreeId === null) return null;
		const list = s.byProject[folderId] ?? [];
		return list.find((w) => w.id === worktreeId) ?? null;
	});
	if (folder === null) return null;
	if (worktreeId === null) return workspaceRequested ? null : folder.path;
	if (worktree === null) return null;
	return worktree.path;
};
