import type { ChatWorkspacePolicy, FolderId } from "@zuse/contracts";

import { useRepositorySettingsStore } from "../store/repository-settings.ts";
import { useSettingsStore } from "../store/settings.ts";

/**
 * Resolve the worktree a freshly-created chat should run in. When per-repo
 * (`autoCreateWorktree`) or global (`defaultAutoCreateWorktree`) auto-create
 * is on, this asks the server-owned bootstrap to create a fresh worktree;
 * otherwise the chat runs in the main checkout.
 *
 * Shared by every chat-creation entry point — the sidebar "New chat" button
 * and the landing screen — so they can't drift: a divergence here is exactly
 * what left landing-screen chats stranded in the main repo while the UI
 * promised a fresh worktree.
 */
export async function resolveChatWorkspacePolicy(
	projectId: FolderId,
): Promise<ChatWorkspacePolicy> {
	const settings = useSettingsStore.getState();
	const repositorySettings = useRepositorySettingsStore.getState();
	const repoSettings =
		repositorySettings.byProject[projectId] ??
		(await repositorySettings.refresh(projectId));
	const shouldAutoCreate =
		repoSettings?.autoCreateWorktree === true ||
		settings.defaultAutoCreateWorktree === true;
	return shouldAutoCreate ? { _tag: "fresh" } : { _tag: "main" };
}
