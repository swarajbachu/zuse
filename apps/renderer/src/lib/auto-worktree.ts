import type {
	ChatWorkspacePolicy,
	EnvironmentId,
	FolderId,
} from "@zuse/contracts";

import {
	repositorySettingsKey,
	useRepositorySettingsStore,
} from "../store/repository-settings.ts";
import { useSettingsStore } from "./settings-client-bus.ts";

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
	environmentId: EnvironmentId,
	projectId: FolderId,
): Promise<ChatWorkspacePolicy> {
	const settings = useSettingsStore.getState();
	const repositorySettings = useRepositorySettingsStore.getState();
	const repoSettings =
		repositorySettings.byProject[
			repositorySettingsKey(environmentId, projectId)
		] ?? (await repositorySettings.refresh(environmentId, projectId));
	const shouldAutoCreate =
		repoSettings?.autoCreateWorktree === true ||
		settings.defaultAutoCreateWorktree === true;
	return shouldAutoCreate ? { _tag: "fresh" } : { _tag: "main" };
}
