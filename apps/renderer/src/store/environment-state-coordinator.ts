import type { ChatId, FolderId } from "@zuse/contracts";

import {
	activateAnnotationsEnvironment,
	useAnnotationsStore,
} from "./annotations.ts";
import { useArchivePreviewStore } from "./archive-preview.ts";
import { useAttachmentsStore } from "./attachments.ts";
import { stopProjectChatStream } from "./chat-commands.ts";
import { useChatsStore } from "./chats.ts";
import { useComposerDraftsStore } from "./composer-drafts.ts";
import type { EnvironmentCatalogEntry } from "./environment-catalog.ts";
import { useExternalThreadsStore } from "./external-threads.ts";
import { useGitChangesStore } from "./git-changes.ts";
import { useGitDiffStatStore } from "./git-diff-stat.ts";
import { useGitReviewStore } from "./git-review.ts";
import { useGitStatusStore } from "./git-status.ts";
import { suspendMessageStreams, useMessagesStore } from "./messages.ts";
import { suspendPermissionStream, usePermissionsStore } from "./permissions.ts";
import { usePrDetailsStore } from "./pr-details.ts";
import { usePrStateStore } from "./pr-state.ts";
import { useRepositorySettingsStore } from "./repository-settings.ts";
import { useSessionRuntimeStore } from "./session-runtime.ts";
import { useSessionsStore } from "./sessions.ts";
import { useTerminalsStore } from "./terminals.ts";
import { useUiStore } from "./ui.ts";
import { useUsageStore } from "./usage.ts";
import { useWorkspaceStore } from "./workspace.ts";
import { useWorktreesStore } from "./worktrees.ts";

type SnapshotStore = {
	readonly getState: () => unknown;
	readonly getInitialState: () => unknown;
	readonly setState: (state: unknown, replace?: boolean) => void;
};

const stores = [
	useWorkspaceStore,
	useChatsStore,
	useComposerDraftsStore,
	useSessionsStore,
	useMessagesStore,
	useAttachmentsStore,
	useAnnotationsStore,
	usePermissionsStore,
	useTerminalsStore,
	useWorktreesStore,
	useArchivePreviewStore,
	useExternalThreadsStore,
	useRepositorySettingsStore,
	useUsageStore,
	useSessionRuntimeStore,
	useGitStatusStore,
	useGitChangesStore,
	useGitDiffStatStore,
	useGitReviewStore,
	usePrStateStore,
	usePrDetailsStore,
] as unknown as ReadonlyArray<SnapshotStore>;

export const createEnvironmentStateRegistry = (
	snapshotStores: ReadonlyArray<SnapshotStore>,
) => {
	const snapshots = new Map<string, ReadonlyArray<unknown>>();
	return {
		capture: (environmentId: string): void => {
			snapshots.set(
				environmentId,
				snapshotStores.map((store) => store.getState()),
			);
		},
		restore: (environmentId: string): boolean => {
			const hadSnapshot = snapshots.has(environmentId);
			const snapshot =
				snapshots.get(environmentId) ??
				snapshotStores.map((store) => store.getInitialState());
			for (let index = 0; index < snapshotStores.length; index += 1) {
				snapshotStores[index]?.setState(snapshot[index], true);
			}
			return hadSnapshot;
		},
		reset: (): void => snapshots.clear(),
	};
};

const stateRegistry = createEnvironmentStateRegistry(stores);

export const activateEnvironmentState = async (input: {
	readonly fromEnvironmentId: string;
	readonly entry: EnvironmentCatalogEntry;
	readonly folderId: FolderId;
	readonly chatId?: ChatId;
	readonly activateConnection: (environmentId: string) => Promise<void>;
	readonly resolveEntry: (
		environmentId: string,
	) => EnvironmentCatalogEntry | undefined;
}): Promise<void> => {
	const currentFolders = useWorkspaceStore.getState().folders;
	stateRegistry.capture(input.fromEnvironmentId);
	await Promise.all([
		...currentFolders.map((folder) => stopProjectChatStream(folder.id)),
		suspendMessageStreams(),
		suspendPermissionStream(),
	]);
	await input.activateConnection(input.entry.environmentId);
	const restoredSnapshot = stateRegistry.restore(input.entry.environmentId);
	if (!restoredSnapshot) activateAnnotationsEnvironment();
	useUiStore.getState().clearRevealedAnnotation();
	const refreshedEntry =
		input.resolveEntry(input.entry.environmentId) ?? input.entry;
	const selectedFolderId = refreshedEntry.folders.some(
		(folder) => folder.id === input.folderId,
	)
		? input.folderId
		: (refreshedEntry.folders[0]?.id ?? null);
	useWorkspaceStore.setState({
		folders: refreshedEntry.folders,
		selectedFolderId,
		loading: false,
		error: null,
	});
	useChatsStore.setState({
		chatsByProject: refreshedEntry.chatsByProject,
		selectedChatId: input.chatId ?? null,
		selectedChatByProject:
			selectedFolderId === null
				? {}
				: { [selectedFolderId]: input.chatId ?? null },
		loadingByProject: {},
		error: null,
	});
	usePermissionsStore.getState().start();
	if (input.chatId !== undefined && selectedFolderId !== null) {
		await useSessionsStore.getState().hydrate(selectedFolderId);
		useChatsStore.getState().select(input.chatId);
	}
};

export const resetEnvironmentStateSnapshotsForTest = (): void => {
	stateRegistry.reset();
};
