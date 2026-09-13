import type { ChatCreationPhase, FolderId, WorktreeId } from "@zuse/contracts";
import { useEffect } from "react";

import { EMPTY_WORKTREES, useWorktreesStore } from "../store/worktrees.ts";

/**
 * Reconcile a worktree reserved by chat creation with the worktree projection,
 * then follow its setup stream. The creation record publishes the id before the
 * checkout row exists, so every lifecycle phase change is a fresh opportunity
 * to hydrate it rather than treating the first empty list response as final.
 */
export function useWorktreeSetupLifecycle(
	projectId: FolderId | null,
	worktreeId: WorktreeId | null,
	creationPhase: ChatCreationPhase | null,
) {
	const worktree = useWorktreesStore((state) => {
		if (projectId === null || worktreeId === null) return null;
		return (
			(state.byProject[projectId] ?? EMPTY_WORKTREES).find(
				(candidate) => candidate.id === worktreeId,
			) ?? null
		);
	});
	const refreshWorktrees = useWorktreesStore((state) => state.refresh);
	const subscribeSetup = useWorktreesStore((state) => state.subscribeSetup);
	const unsubscribeSetup = useWorktreesStore((state) => state.unsubscribeSetup);
	const worktreeHydrated = worktree !== null;

	useEffect(() => {
		if (projectId === null || worktreeId === null) return;
		void refreshWorktrees(projectId);
	}, [creationPhase, projectId, refreshWorktrees, worktreeId]);

	useEffect(() => {
		if (projectId === null || worktreeId === null || !worktreeHydrated) return;
		subscribeSetup(projectId, worktreeId);
		return () => unsubscribeSetup(projectId, worktreeId);
	}, [
		projectId,
		subscribeSetup,
		unsubscribeSetup,
		worktreeHydrated,
		worktreeId,
	]);

	return worktree;
}
