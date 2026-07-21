import type { FolderId, WorktreeId } from "@zuse/contracts";

import { useRepositorySettingsStore } from "../store/repository-settings.ts";
import { useSettingsStore } from "../store/settings.ts";
import { useWorktreesStore } from "../store/worktrees.ts";

/**
 * Resolve the worktree a freshly-created chat should run in. When per-repo
 * (`autoCreateWorktree`) or global (`defaultAutoCreateWorktree`) auto-create
 * is on, this spins up a new worktree and returns its id; otherwise it
 * returns `null` (chat runs in the main checkout).
 *
 * Shared by every chat-creation entry point — the sidebar "New chat" button
 * and the landing screen — so they can't drift: a divergence here is exactly
 * what left landing-screen chats stranded in the main repo while the UI
 * promised a fresh worktree.
 */
export async function resolveAutoWorktreeId(
	projectId: FolderId,
): Promise<WorktreeId | null> {
	const settings = useSettingsStore.getState();
	const repoSettings = await useRepositorySettingsStore
		.getState()
		.refresh(projectId);
	const shouldAutoCreate =
		repoSettings?.autoCreateWorktree === true ||
		settings.defaultAutoCreateWorktree === true;
	if (!shouldAutoCreate) return null;
	const wt = await useWorktreesStore.getState().create(projectId);
	if (wt !== null) return wt.id;

	const reason = useWorktreesStore.getState().error;
	throw new Error(
		reason === null
			? "Couldn't create an isolated worktree."
			: `Couldn't create an isolated worktree: ${reason}`,
	);
}
