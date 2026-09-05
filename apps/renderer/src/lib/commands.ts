import type { ChatRef } from "@zuse/client-runtime/resource-ref";
import type { ChatId, Command, Session } from "@zuse/contracts";
import { defaultModelFor, EnvironmentId, PROVIDER_IDS } from "@zuse/contracts";
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

/* ────────────────────────── Navigation helpers ──────────────────────────
 * Read state via `.getState()` (no subscription) and fire the same store
 * actions the mouse path uses. Tab ordering is shared with the tab strip via
 * `lib/tab-order.ts` so keyboard and click land on the same tab.
 */

/** Sessions belonging to the currently-selected project. */
function currentProjectSessions(): ReadonlyArray<Session> {
	const projectId = useWorkspaceStore.getState().selectedFolderId;
	if (projectId === null) return [];
	return activeSessionsByProject()[projectId] ?? [];
}

/** The chat whose sessions fill the tab strip right now. */
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

/** Move the active tab by `delta` within the active chat, wrapping around. */
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

/** Select the 1-based Nth tab; no-op if it doesn't exist. */
function selectTabAt(oneBased: number): void {
	const tabs = orderedChatTabs(currentProjectSessions(), currentChatId());
	const target = tabs[oneBased - 1];
	if (target !== undefined) useSessionsStore.getState().select(target.id);
}

/** Select the last tab in the active chat. */
function selectLastTab(): void {
	const tabs = orderedChatTabs(currentProjectSessions(), currentChatId());
	const target = tabs[tabs.length - 1];
	if (target !== undefined) useSessionsStore.getState().select(target.id);
}

/** Open a fresh session in the active chat — the tab-strip "+" button, by key. */
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
			title: "No authenticated agent",
			description:
				"Connect an agent in Cloud Authentication before opening a new tab.",
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

/** Move the selected chat by `delta` within the project, wrapping around. */
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

/** Move the active right-pane panel by `delta`, wrapping around; opens the
 *  right sidebar first if it's collapsed. */
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

/**
 * One handler per `Command`. Composer / editor commands are no-ops here —
 * they're owned by the matching CodeMirror keymaps (composer-keymap.ts,
 * setup.ts) which build themselves from the live keybindings store. Having
 * them in the registry anyway keeps the dispatcher exhaustive and lets the
 * settings UI render them in the same table as menu commands.
 *
 * Each handler is invoked from either:
 *   - the document-level keybinding dispatcher (`useKeybindingDispatch`)
 *   - the native menu IPC handler (`useMenuShortcuts`)
 *
 * Both call `dispatchCommand` which is the single fan-in point. Stores are
 * referenced via `.getState()` so the registry doesn't subscribe to
 * anything — it just fires effects.
 */
const HANDLERS: Record<Command, () => void> = {
	"new-chat": () => {
		const selectedChatId = useChatsStore.getState().selectedChatId;
		const cloudProjectId =
			selectedChatId === null ? null : localProjectForCloudChat(selectedChatId);
		if (cloudProjectId !== null) {
			if (
				useEnvironmentCatalogStore.getState().activeEnvironmentId ===
				getLocalEnvironmentId()
			) {
				openNewChatLanding(cloudProjectId);
				return;
			}
			void switchToEnvironment({
				environmentId: getLocalEnvironmentId(),
				folderId: cloudProjectId,
			}).then((result) => {
				if (result.switched && result.selectedFolderId !== null)
					openNewChatLanding(result.selectedFolderId);
			});
			return;
		}
		const projectId = useWorkspaceStore.getState().selectedFolderId;
		if (projectId === null) return;
		openNewChatLanding(projectId);
	},
	"open-project": () => {
		openProjectSetupDialog();
	},
	settings: () => {
		const ui = useUiStore.getState();
		ui.setView(ui.view === "settings" ? "chat" : "settings");
	},
	"close-tab": () => {
		// Owned by `app.tsx` directly — kept here for completeness so the
		// settings UI lists Close Tab in the same table as the others. The
		// native menu's Cmd+W still uses its dedicated IPC signal, and the
		// document dispatcher doesn't fire this scope.
	},
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
		// Open the sidebar (if closed) and reveal a terminal panel — focus an
		// existing one or add a fresh terminal tab.
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

/**
 * Commands handled by the document-level keybinding dispatcher. Composer
 * and editor commands are excluded because the matching CodeMirror keymap
 * already handles them inside its own focused element, and double-firing
 * would (a) submit twice and (b) preventDefault on the native typing event.
 */
export const APPLICATION_COMMANDS: ReadonlySet<Command> = new Set<Command>([
	"new-chat",
	"open-project",
	"settings",
	"toggle-left-sidebar",
	"toggle-right-sidebar",
	"toggle-terminal",
	"focus-composer",
	"next-tab",
	"prev-tab",
	"select-tab-1",
	"select-tab-2",
	"select-tab-3",
	"select-tab-4",
	"select-tab-5",
	"select-tab-6",
	"select-tab-7",
	"select-tab-8",
	"select-last-tab",
	"new-tab",
	"next-chat",
	"prev-chat",
	"next-panel",
	"prev-panel",
	"focus-next-pane",
	"focus-prev-pane",
	"open-chat-switcher",
	// `close-tab` deliberately omitted — see app.tsx's onCloseTab handler.
]);
