import { batchAtomUpdates } from "../state/registry.tsx";
import { useChatsStore } from "../store/chats.ts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { rendererAccountSnapshot } from "./renderer-account.ts";
import {
	rendererWorkspaceSnapshot,
	subscribeRendererWorkspace,
} from "./renderer-workspace.ts";
import { getActiveEnvironment } from "./rpc-client.ts";

const capture = () => {
	const ui = useUiStore.getState();
	const chats = useChatsStore.getState();
	const sessions = useSessionsStore.getState();
	return {
		environmentId: getActiveEnvironment(),
		folderId: useWorkspaceStore.getState().selectedFolderId,
		ui: {
			view: ui.view,
			settingsSection: ui.settingsSection,
			activeMainTab: ui.activeMainTab,
			usageScope: ui.usageScope,
			openFile: ui.openFile,
			changesTabOpen: ui.changesTabOpen,
			reviewTabScope: ui.reviewTabScope,
			reviewNavigation: ui.reviewNavigation,
		},
		chats: {
			selectedChatId: chats.selectedChatId,
			selectedChatByProject: chats.selectedChatByProject,
		},
		sessions: {
			selectedSessionId: sessions.selectedSessionId,
			selectedSessionByProject: sessions.selectedSessionByProject,
			draftSession: sessions.draftSession,
			draftSkills: sessions.draftSkills,
		},
	};
};
type Navigation = ReturnType<typeof capture>;

const restore = (navigation?: Navigation) =>
	batchAtomUpdates(() => {
		useUiStore.setState({
			...(navigation?.ui ?? {
				view: "chat",
				settingsSection: { kind: "general" },
				activeMainTab: "chat",
				usageScope: "global",
				openFile: null,
				changesTabOpen: false,
				reviewTabScope: null,
				reviewNavigation: null,
			}),
			fileDirty: false,
			fileSearchOpen: false,
			chatSwitcherOpen: false,
			revealedAnnotation: null,
		});
		useChatsStore.setState((state) => ({
			...(navigation?.chats ?? {
				selectedChatId: null,
				selectedChatByProject: {},
			}),
			landingRevision: state.landingRevision + 1,
			error: null,
		}));
		useSessionsStore.setState((state) => ({
			...(navigation?.sessions ?? {
				selectedSessionId: null,
				selectedSessionByProject: {},
				draftSession: null,
				draftSkills: [],
			}),
			draftRevision: state.draftRevision + 1,
			error: null,
		}));
		useWorkspaceStore.setState({
			selectedFolderId: navigation?.folderId ?? null,
			loading: false,
			error: null,
		});
	});

export const startWorkspaceNavigation = (): (() => void) => {
	const saved = new Map<string, Navigation>();
	let account = rendererAccountSnapshot();
	let workspace = rendererWorkspaceSnapshot();
	let stopped = false;
	let pending: { key: string; revision: number } | null = null;
	const unsubscribe = subscribeRendererWorkspace(() => {
		const nextAccount = rendererAccountSnapshot();
		const next = rendererWorkspaceSnapshot();
		if (nextAccount !== account) {
			saved.clear();
			pending = null;
			const initialAuthentication = account.subject === undefined;
			account = nextAccount;
			workspace = next;
			if (!initialAuthentication) restore();
			return;
		}
		if (workspace.key === next.key) return;

		if (
			pending?.key !== workspace.key ||
			pending.revision !== useChatsStore.getState().landingRevision ||
			useWorkspaceStore.getState().selectedFolderId !== null
		)
			saved.set(workspace.key, capture());
		pending = null;
		workspace = next;
		const navigation = saved.get(next.key);
		if (
			navigation === undefined ||
			navigation.environmentId === getActiveEnvironment()
		) {
			restore(navigation);
			return;
		}
		restore();
		const revision = useChatsStore.getState().landingRevision;
		pending = { key: next.key, revision };
		const isCurrent = () =>
			!stopped &&
			rendererWorkspaceSnapshot() === next &&
			useChatsStore.getState().landingRevision === revision &&
			useWorkspaceStore.getState().selectedFolderId === null;
		void useEnvironmentCatalogStore
			.getState()
			.activate(navigation.environmentId, {
				...(navigation.folderId === null
					? {}
					: { folderId: navigation.folderId }),
				...(navigation.chats.selectedChatId === null
					? {}
					: { chatId: navigation.chats.selectedChatId }),
				isCurrent,
			})
			.then(() => {
				if (
					!stopped &&
					rendererWorkspaceSnapshot() === next &&
					useChatsStore.getState().landingRevision === revision &&
					getActiveEnvironment() === navigation.environmentId
				) {
					pending = null;
					restore(navigation);
				}
			})
			.catch((cause: unknown) => {
				if (isCurrent())
					useWorkspaceStore.setState({
						error:
							cause instanceof Error
								? cause.message
								: "Could not restore this workspace.",
					});
			});
	});
	return () => {
		stopped = true;
		unsubscribe();
	};
};
