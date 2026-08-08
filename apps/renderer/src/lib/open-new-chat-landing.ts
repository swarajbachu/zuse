import type { FolderId } from "@zuse/contracts";

import { useChatsStore } from "../store/chats.ts";
import { useUiStore } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";

/**
 * Open the new-chat landing for a project without creating a worktree, chat,
 * or session. Keeping this store-only action outside the sidebar prevents
 * global command handling from eagerly loading the sidebar component tree.
 */
export function openNewChatLanding(projectId: FolderId): void {
	// The landing lives on the chat tab. Return there before clearing the
	// selection so creating a chat from Usage or Archives is immediately
	// visible instead of leaving that takeover surface mounted.
	useUiStore.getState().setActiveMainTab("chat");
	// Select the project first (synchronous: `workspace.select` sets
	// `selectedFolderId` before awaiting persistence), then clear the chat +
	// session selection for it. `chats.select(null)` cascades into
	// `sessions.select(null)`, so both the tab strip and the chat surface fall
	// back to the empty landing for this project.
	if (useWorkspaceStore.getState().selectedFolderId !== projectId) {
		void useWorkspaceStore.getState().select(projectId);
	}
	useChatsStore.getState().select(null);
}
