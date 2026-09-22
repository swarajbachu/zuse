import type { FolderId } from "@zuse/contracts";

import { batchAtomUpdates } from "../state/registry.tsx";
import { useChatsStore } from "../store/chats.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { getActiveEnvironment } from "./rpc-client.ts";

/**
 * Open the new-chat landing for a project without creating a worktree, chat,
 * or session. Keeping this store-only action outside the sidebar prevents
 * global command handling from eagerly loading the sidebar component tree.
 */
export function openNewChatLanding(projectId: FolderId): void {
	batchAtomUpdates(() => {
		useUiStore.getState().setActiveMainTab("chat");
		// Clear the destination slots before switching projects. Subscribers must
		// never restore its previous chat while opening the landing.
		useChatsStore.setState((state) => ({
			selectedChatByProject: {
				...state.selectedChatByProject,
				[projectId]: null,
			},
		}));
		useSessionsStore.setState((state) => ({
			selectedSessionByProject: {
				...state.selectedSessionByProject,
				[projectId]: null,
			},
		}));
		if (useWorkspaceStore.getState().selectedFolderId !== projectId) {
			void useWorkspaceStore.getState().select(projectId);
		}
		useChatsStore.getState().select(null);
	});
}

/** Async launches may open their result only while their landing is still selected. */
export function captureNewChatLanding(): () => boolean {
	const environmentId = getActiveEnvironment();
	const projectId = useWorkspaceStore.getState().selectedFolderId;
	const revision = useChatsStore.getState().landingRevision;
	const draftRevision = useSessionsStore.getState().draftRevision;
	return () =>
		getActiveEnvironment() === environmentId &&
		useWorkspaceStore.getState().selectedFolderId === projectId &&
		useChatsStore.getState().landingRevision === revision &&
		useChatsStore.getState().selectedChatId === null &&
		useSessionsStore.getState().draftRevision === draftRevision &&
		useUiStore.getState().activeMainTab === "chat";
}

/** Recover a still-mounted landing without touching a replacement draft. */
export function resetCompletedChatDraft(
	draftRevision: number,
	resetLanding: () => void,
): void {
	if (
		useSessionsStore.getState().draftRevision !== draftRevision ||
		useChatsStore.getState().selectedChatId !== null
	)
		return;
	useSessionsStore.getState().clearDraft(draftRevision);
	resetLanding();
}
