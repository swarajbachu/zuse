import type { Chat, ChatId, FolderId, Message, Session } from "@zuse/contracts";

import {
	retryRendererRpcConnection,
	subscribeRendererRpcConnection,
} from "../lib/rpc-client.ts";
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
import { useGitReviewStore } from "./git-review.ts";
import { useGitStatusStore } from "./git-status.ts";
import { suspendMessageStreams, useMessagesStore } from "./messages.ts";
import { suspendPermissionStream, usePermissionsStore } from "./permissions.ts";
import { usePrDetailsStore } from "./pr-details.ts";
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
	useGitReviewStore,
	usePrDetailsStore,
	// NOT swapped: usePrStateStore and useGitDiffStatStore are keyed by
	// environment id, so rows from every computer keep their PR/diff data
	// across switches.
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

/** Cancels the previous activation's pending connection-gated hydration. */
let cancelPendingChatHydration: (() => void) | null = null;

/**
 * Kick off chat-list hydration for the restored folders once the target
 * environment's connection is actually OPEN — firing list RPCs into a socket
 * that is still connecting (or a computer that just went to sleep) would only
 * produce "couldn't reach" errors. The supervisor reconnects on its own; the
 * hydration fires on the first connected snapshot and exactly once.
 */
const hydrateChatsWhenConnected = (
	environmentId: string,
	folderIds: ReadonlyArray<FolderId>,
): void => {
	cancelPendingChatHydration?.();
	cancelPendingChatHydration = null;
	if (folderIds.length === 0) return;
	let done = false;
	let unsubscribe: (() => void) | null = null;
	try {
		unsubscribe = subscribeRendererRpcConnection((snapshot) => {
			if (done || snapshot.status !== "connected") return;
			done = true;
			unsubscribe?.();
			for (const folderId of folderIds) {
				void useChatsStore.getState().hydrate(folderId);
			}
		}, environmentId);
	} catch {
		// Connection not registered (should not happen for a catalog-connected
		// entry) — fall back to hydrating immediately.
		for (const folderId of folderIds) {
			void useChatsStore.getState().hydrate(folderId);
		}
		return;
	}
	if (done) {
		unsubscribe();
		return;
	}
	cancelPendingChatHydration = () => {
		done = true;
		unsubscribe?.();
	};
	// An idle entry only connects when something dispatches on it — nudge it
	// so the chat lists don't wait for the next catalog poll.
	retryRendererRpcConnection(environmentId);
};

/**
 * A chat freshly created on the target environment, seeded into its stores
 * during activation so selecting the chat never races the catalog poller.
 */
export type ActivateEnvironmentSeed = {
	readonly chat: Chat;
	readonly initialSession: Session;
	readonly initialMessage: Message | null;
};

export const activateEnvironmentState = async (input: {
	readonly fromEnvironmentId: string;
	readonly entry: EnvironmentCatalogEntry;
	readonly folderId?: FolderId;
	readonly chatId?: ChatId;
	readonly seed?: ActivateEnvironmentSeed;
	readonly activateConnection: (environmentId: string) => Promise<void>;
	readonly resolveEntry: (
		environmentId: string,
	) => EnvironmentCatalogEntry | undefined;
}): Promise<FolderId | null> => {
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
	const selectedFolderId =
		input.folderId !== undefined &&
		refreshedEntry.folders.some((folder) => folder.id === input.folderId)
			? input.folderId
			: (refreshedEntry.folders[0]?.id ?? null);
	useWorkspaceStore.setState({
		folders: refreshedEntry.folders,
		selectedFolderId,
		loading: false,
		error: null,
	});
	const seed = input.seed;
	const chatsByProject =
		seed === undefined || selectedFolderId === null
			? refreshedEntry.chatsByProject
			: {
					...refreshedEntry.chatsByProject,
					[selectedFolderId]: [
						seed.chat,
						...(refreshedEntry.chatsByProject[selectedFolderId] ?? []).filter(
							(chat) => chat.id !== seed.chat.id,
						),
					],
				};
	useChatsStore.setState({
		chatsByProject,
		selectedChatId: input.chatId ?? null,
		selectedChatByProject:
			selectedFolderId === null
				? {}
				: { [selectedFolderId]: input.chatId ?? null },
		loadingByProject: {},
		error: null,
	});
	if (seed !== undefined && selectedFolderId !== null) {
		useSessionsStore.setState((s) => ({
			sessionsByProject: {
				...s.sessionsByProject,
				[selectedFolderId]: [
					seed.initialSession,
					...(s.sessionsByProject[selectedFolderId] ?? []).filter(
						(session) => session.id !== seed.initialSession.id,
					),
				],
			},
		}));
		if (seed.initialMessage !== null) {
			const initialMessage = seed.initialMessage;
			useMessagesStore.setState((s) => ({
				messagesBySession: {
					...s.messagesBySession,
					[seed.initialSession.id]: [initialMessage],
				},
			}));
		}
	}
	usePermissionsStore.getState().start();
	// The pre-populated `chatsByProject` keys defeat the sidebar's lazy
	// `hydrateChats` guard, and `hydrate` is the only path that establishes
	// `chat.streamChanges` — without this, chat lists freeze after a switch.
	hydrateChatsWhenConnected(
		input.entry.environmentId,
		refreshedEntry.folders.map((folder) => folder.id),
	);
	if (input.chatId !== undefined && selectedFolderId !== null) {
		await useSessionsStore.getState().hydrate(selectedFolderId);
		useChatsStore.getState().select(input.chatId);
	}
	return selectedFolderId;
};

export const resetEnvironmentStateSnapshotsForTest = (): void => {
	stateRegistry.reset();
};
