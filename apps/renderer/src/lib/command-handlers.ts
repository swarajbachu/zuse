import { isHostedProduct } from "./hosted-session.ts";
import "@zuse/i18n/english/commands";
import type { ChatRef } from "@zuse/client-runtime/resource-ref";
import type { ChatId, Command, Session } from "@zuse/contracts";
import { defaultModelFor, EnvironmentId, PROVIDER_IDS } from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import { toastManager } from "../components/ui/toast.tsx";
import { useChatsStore } from "../store/chats";
import { useComposerBridge } from "../store/composer-bridge";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { currentModelCatalog } from "../store/model-catalog.ts";
import { usePaneFocus } from "../store/pane-focus";
import { useProvidersStore } from "../store/providers";
import { useSessionsStore } from "../store/sessions";
import { rightPaneKey, useUiStore } from "../store/ui";
import { useWorkspaceStore } from "../store/workspace";
import { captureAnalytics } from "./analytics";
import { resolveChatRuntimeMode } from "./auto-worktree.ts";
import {
	cloudSummaryForChat,
	cloudSummaryForEnvironment,
	localProjectForCloudChat,
} from "./cloud-workspace-catalog.ts";
import {
	activeChatsByProject,
	activeSessionsByProject,
} from "./environment-entities.ts";
import { selectAuthenticatedProvider } from "./model-picker-availability.ts";
import { openNewChatLanding } from "./open-new-chat-landing.ts";
import { openProjectSetupDialog } from "./project-setup-dialog-state.ts";
import { getLocalEnvironmentId } from "./rpc-client.ts";
import { useSettingsStore } from "./settings-client-bus.ts";
import { switchToEnvironment } from "./switch-environment.ts";
import { activeChatId, orderedChatTabs } from "./tab-order";

function currentProjectSessions(): ReadonlyArray<Session> {
	const projectId = useWorkspaceStore.getState().selectedFolderId;
	if (projectId === null) return [];
	return activeSessionsByProject()[projectId] ?? [];
}

function currentChatId(): ChatId | null {
	return activeChatId(
		currentProjectSessions(),
		useSessionsStore.getState().selectedSessionId,
		useChatsStore.getState().selectedChatId,
	);
}

function currentChatRef(): ChatRef | null {
	const chatId = currentChatId();
	return chatId === null
		? null
		: {
				environmentId: EnvironmentId.make(
					cloudSummaryForChat(chatId)?.workspaceId ??
						useEnvironmentCatalogStore.getState().activeEnvironmentId,
				),
				chatId,
			};
}

function stepTab(delta: 1 | -1): void {
	const tabs = orderedChatTabs(currentProjectSessions(), currentChatId());
	if (tabs.length === 0) return;
	const selectedId = useSessionsStore.getState().selectedSessionId;
	const idx = tabs.findIndex((t) => t.id === selectedId);
	const base = idx === -1 ? 0 : idx;
	const next = (base + delta + tabs.length) % tabs.length;
	const target = tabs[next];
	if (target !== undefined) useSessionsStore.getState().select(target.id);
}

function selectTabAt(oneBased: number): void {
	const tabs = orderedChatTabs(currentProjectSessions(), currentChatId());
	const target = tabs[oneBased - 1];
	if (target !== undefined) useSessionsStore.getState().select(target.id);
}

function selectLastTab(): void {
	const tabs = orderedChatTabs(currentProjectSessions(), currentChatId());
	const target = tabs[tabs.length - 1];
	if (target !== undefined) useSessionsStore.getState().select(target.id);
}

async function newTabInActiveChat(): Promise<void> {
	const chatId = currentChatId();
	if (chatId === null) return;
	const environmentId = EnvironmentId.make(
		cloudSummaryForChat(chatId)?.workspaceId ??
			useEnvironmentCatalogStore.getState().activeEnvironmentId,
	);
	const settings = useSettingsStore.getState();
	await useProvidersStore.getState().loadFor(environmentId);
	const environmentAvailability =
		useProvidersStore.getState().availabilityByEnvironment[environmentId]
			?.availability ?? [];
	const providerId = selectAuthenticatedProvider({
		preferredProviderId: settings.defaultProviderId,
		providerIds: PROVIDER_IDS,
		availability: environmentAvailability,
		providerEnabled: settings.providerEnabled ?? {},
	});
	if (providerId === null) {
		toastManager.add({
			type: "error",
			title: uiMessage("commands:commands_no_authenticated_agent"),
			description: uiMessage(
				"commands:commands_connect_an_agent_in_cloud_authentication_before_opening_a_new_tab",
			),
		});
		return;
	}
	const fresh = useSettingsStore.getState();
	const model =
		fresh.defaultModelByProvider[providerId] ??
		defaultModelFor(currentModelCatalog(), providerId);
	const projectId = useWorkspaceStore.getState().selectedFolderId;
	const runtimeMode =
		projectId === null
			? fresh.defaultRuntimeMode
			: await resolveChatRuntimeMode(environmentId, projectId);
	await useSessionsStore.getState().create(chatId, providerId, model, {
		runtimeMode,
	});
}

function stepChat(delta: 1 | -1): void {
	const projectId = useWorkspaceStore.getState().selectedFolderId;
	if (projectId === null) return;
	const chats = useChatsStore.getState();
	const list = (activeChatsByProject()[projectId] ?? []).filter(
		(c) => c.archivedAt === null,
	);
	if (list.length === 0) return;
	const idx = list.findIndex((c) => c.id === chats.selectedChatId);
	const base = idx === -1 ? 0 : idx;
	const next = (base + delta + list.length) % list.length;
	const target = list[next];
	if (target !== undefined) chats.select(target.id);
}

function stepPanel(delta: 1 | -1): void {
	const ui = useUiStore.getState();
	const ref = currentChatRef();
	if (ref === null) return;
	const key = rightPaneKey(ref);
	const panels = ui.rightPanelsByChat[key] ?? [];
	if (panels.length === 0) return;
	if (ui.rightPaneLayoutByChat[key]?.open !== true) {
		ui.setRightSidebarOpenForChat(ref, true);
	}
	const activeId = ui.activeRightPanelByChat[key] ?? null;
	const idx = panels.findIndex((p) => p.id === activeId);
	const base = idx === -1 ? 0 : idx;
	const next = (base + delta + panels.length) % panels.length;
	const target = panels[next];
	if (target !== undefined) ui.setActiveRightPanel(ref, target.id);
}

const HANDLERS: Record<Command, () => void> = {
	"search-files": () => useUiStore.getState().setFileSearchOpen(true),
	"new-chat-without-project": () => {
		if (!isHostedProduct()) openNewChatLanding(null);
	},
	"new-chat": () => {
		if (isHostedProduct()) {
			void import("./hosted-workspace.ts").then((m) =>
				m.selectHostedCloudHome(),
			);
			return;
		}
		const selectedChatId = useChatsStore.getState().selectedChatId;
		const cloudProjectId =
			selectedChatId === null ? null : localProjectForCloudChat(selectedChatId);
		const { activeEnvironmentId } = useEnvironmentCatalogStore.getState();
		// A cloud chat without a local project opens in its own transient
		// environment; new chats always start back on this computer.
		const leaveEnvironment =
			activeEnvironmentId !== getLocalEnvironmentId() &&
			(cloudProjectId !== null ||
				cloudSummaryForEnvironment(activeEnvironmentId) !== null);
		if (!leaveEnvironment) {
			openNewChatLanding(
				cloudProjectId ?? useWorkspaceStore.getState().selectedFolderId,
			);
			return;
		}
		void switchToEnvironment({
			environmentId: getLocalEnvironmentId(),
			folderId: cloudProjectId ?? undefined,
		}).then((result) => {
			if (result.switched) openNewChatLanding(result.selectedFolderId);
		});
	},
	"open-project": () => {
		openProjectSetupDialog();
	},
	settings: () => {
		const ui = useUiStore.getState();
		ui.setView(ui.view === "settings" ? "chat" : "settings");
	},
	"close-tab": () => {},
	"toggle-left-sidebar": () => {
		const ui = useUiStore.getState();
		ui.setLeftSidebarOpen(!ui.leftSidebarOpen);
	},
	"toggle-right-sidebar": () => {
		const ui = useUiStore.getState();
		const ref = currentChatRef();
		if (ref === null) return;
		const key = rightPaneKey(ref);
		ui.setRightSidebarOpenForChat(
			ref,
			ui.rightPaneLayoutByChat[key]?.open !== true,
		);
	},
	"toggle-terminal": () => {
		const ref = currentChatRef();
		if (ref !== null) useUiStore.getState().revealPanelForChat(ref, "terminal");
	},
	"focus-composer": () => {
		useComposerBridge.getState().focus?.();
	},
	"next-tab": () => stepTab(1),
	"prev-tab": () => stepTab(-1),
	"select-tab-1": () => selectTabAt(1),
	"select-tab-2": () => selectTabAt(2),
	"select-tab-3": () => selectTabAt(3),
	"select-tab-4": () => selectTabAt(4),
	"select-tab-5": () => selectTabAt(5),
	"select-tab-6": () => selectTabAt(6),
	"select-tab-7": () => selectTabAt(7),
	"select-tab-8": () => selectTabAt(8),
	"select-last-tab": () => selectLastTab(),
	"new-tab": () => {
		void newTabInActiveChat();
	},
	"next-chat": () => stepChat(1),
	"prev-chat": () => stepChat(-1),
	"next-panel": () => stepPanel(1),
	"prev-panel": () => stepPanel(-1),
	"focus-next-pane": () => usePaneFocus.getState().focusAdjacent(1),
	"focus-prev-pane": () => usePaneFocus.getState().focusAdjacent(-1),
	"open-chat-switcher": () => useUiStore.getState().toggleChatSwitcher(),
	"composer.submit": () => {},
	"composer.newline": () => {},
	"composer.forceSubmit": () => {},
	"composer.previousMessage": () => {},
	"composer.nextMessage": () => {},
	"composer.queueSubmit": () => {},
	"composer.deleteToStart": () => {},
	"composer.deleteToEnd": () => {},
	"composer.deleteWord": () => {},
	"composer.interrupt": () => {},
	"composer.togglePlanMode": () => {},
	"editor.save": () => {},
	"editor.annotate": () => {},
};

/**
 * Fire a command. Lookup is type-safe — TypeScript catches any unknown
 * literal. The handler runs synchronously; callers `preventDefault` on
 * the originating event before dispatching when they want the host
 * surface (browser, CodeMirror) to skip its default behaviour.
 */
export function dispatchCommand(command: Command): void {
	captureAnalytics("control activated", {
		screen: document.body.dataset.analyticsScreen ?? "unknown",
		control: `command.${command}`,
		interaction_source: "command",
	});
	const fn = HANDLERS[command];
	fn();
}
