import { EnvironmentId, type Session } from "@zuse/contracts";
import { Effect } from "effect";
import {
	lazy,
	type RefObject,
	Suspense,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	Group,
	Panel,
	Separator,
	useDefaultLayout,
	usePanelRef,
} from "react-resizable-panels";
import { PendingChatCreationSurface } from "./components/pending-chat-creation.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { useChatDirectoryStatus } from "./hooks/use-chat-directory-status.ts";
import { useKeybindingDispatch } from "./hooks/use-keybinding-dispatch.ts";
import { useMediaQuery } from "./hooks/use-media-query.ts";
import { useMenuShortcuts } from "./hooks/use-menu-shortcuts.ts";
import { useReportRuntimeActivity } from "./hooks/use-report-runtime-activity.ts";
import {
	startDesktopAnalytics,
	trackAnalyticsScreen,
} from "./lib/analytics.ts";
import { AppearanceController } from "./lib/appearance.tsx";
import { selectChatSurface } from "./lib/chat-surface-selection.ts";
import { installClientBusOnlineBridge } from "./lib/client-bus-online.ts";
import { closeActiveChatTab } from "./lib/close-chat-tab.ts";
import { cloudSummaryActiveSessionId } from "./lib/cloud-workspace-catalog.ts";
import {
	cloudSessionPlaceholder,
	useCloudChatSummaryForSelection,
} from "./lib/cloud-workspaces.ts";
import { useActiveSessionById } from "./lib/environment-entity-hooks.ts";
import { useGitWorkspaceResource } from "./lib/git-workspace-client-bus.ts";
import { markRendererStartupMilestone } from "./lib/performance-marks.ts";
import { getRpcClient } from "./lib/rpc-client.ts";
import { useSettingsStore } from "./lib/settings-client-bus.ts";
import {
	type SidebarVisibilitySnapshot,
	shouldAnimateSidebarVisibility,
} from "./lib/sidebar-panel-motion.ts";
import { shouldMountRightPane } from "./shell/right-pane-lifecycle.ts";
import { useActiveContext } from "./store/active-workspace.ts";
import { useChatsStore } from "./store/chats.ts";
import { useEnvironmentCatalogStore } from "./store/environment-catalog.ts";
import { useSessionsStore } from "./store/sessions.ts";
import { useTerminalsStore } from "./store/terminals.ts";
import {
	DEFAULT_RIGHT_PANE_WIDTH_PERCENT,
	openFileBelongsToProject,
	rightPaneKey,
	useUiStore,
} from "./store/ui.ts";
import { useWorkspaceStore } from "./store/workspace.ts";
import { useWorktreesStore } from "./store/worktrees.ts";

const PANEL_GROUP_ID = "zuse.shell.v3";
const PANEL_IDS = ["projects", "main", "files"];

/** Keeps the selected checkout live even when no Git-specific panel is open. */
function ActiveGitWorkspaceLease() {
	const context = useActiveContext();
	const ref = useMemo(
		() =>
			context.status === "ready"
				? {
						environmentId: context.environmentId,
						folderId: context.folderId,
						worktreeId: context.worktreeId,
						rootPath: context.rootPath,
					}
				: null,
		[context],
	);
	useGitWorkspaceResource(ref, "connect");
	return null;
}

const MainTabs = lazy(() =>
	import("./components/main-tabs.tsx").then((module) => ({
		default: module.MainTabs,
	})),
);
const ChatLanding = lazy(() =>
	import("./components/chat-landing.tsx").then((module) => ({
		default: module.ChatLanding,
	})),
);
const ProjectsSidebar = lazy(() =>
	import("./components/projects-sidebar.tsx").then((module) => ({
		default: module.ProjectsSidebar,
	})),
);
const TopBarLeft = lazy(() =>
	import("./components/top-bar.tsx").then((module) => ({
		default: module.TopBarLeft,
	})),
);
const TopBarMain = lazy(() =>
	import("./components/top-bar.tsx").then((module) => ({
		default: module.TopBarMain,
	})),
);
const TopBarRight = lazy(() =>
	import("./components/top-bar.tsx").then((module) => ({
		default: module.TopBarRight,
	})),
);
const ChatSwitcher = lazy(() =>
	import("./components/chat-switcher.tsx").then((module) => ({
		default: module.ChatSwitcher,
	})),
);
const CloudConnectionNotice = lazy(() =>
	import("./components/cloud-connection-notice.tsx").then((module) => ({
		default: module.CloudConnectionNotice,
	})),
);
const CliUpgradeBanner = lazy(() =>
	import("./components/cli-upgrade-banner.tsx").then((module) => ({
		default: module.CliUpgradeBanner,
	})),
);
const DirectoryUnavailableBanner = lazy(() =>
	import("./components/directory-unavailable-banner.tsx").then((module) => ({
		default: module.DirectoryUnavailableBanner,
	})),
);
const EnvironmentSummary = lazy(() =>
	import("./components/environment-summary.tsx").then((module) => ({
		default: module.EnvironmentSummary,
	})),
);
const NearbyPairingApproval = lazy(() =>
	import("./components/nearby-pairing-approval.tsx").then((module) => ({
		default: module.NearbyPairingApproval,
	})),
);
const NotchTrayBridge = lazy(() =>
	import("./components/notch-tray-bridge.tsx").then((module) => ({
		default: module.NotchTrayBridge,
	})),
);
const PairingLinkAccept = lazy(() =>
	import("./components/pairing-link-accept.tsx").then((module) => ({
		default: module.PairingLinkAccept,
	})),
);
const ProviderUpdatesToast = lazy(() =>
	import("./components/provider-updates-toast.tsx").then((module) => ({
		default: module.ProviderUpdatesToast,
	})),
);
const SidebarPeekOverlay = lazy(() =>
	import("./components/sidebar-peek.tsx").then((module) => ({
		default: module.SidebarPeekOverlay,
	})),
);
const SidebarPeekTrigger = lazy(() =>
	import("./components/sidebar-peek.tsx").then((module) => ({
		default: module.SidebarPeekTrigger,
	})),
);
const UpdateBanner = lazy(() =>
	import("./components/update-banner.tsx").then((module) => ({
		default: module.UpdateBanner,
	})),
);
const ArchivedChatsPage = lazy(() =>
	import("./components/archived-chats-page.tsx").then((module) => ({
		default: module.ArchivedChatsPage,
	})),
);
const ChatComposer = lazy(() =>
	import("./components/chat-composer.tsx").then((module) => ({
		default: module.ChatComposer,
	})),
);
const ChatView = lazy(() =>
	import("./components/chat-view.tsx").then((module) => ({
		default: module.ChatView,
	})),
);
const ChangesReview = lazy(() =>
	import("./components/changes-review.tsx").then((module) => ({
		default: module.ChangesReview,
	})),
);
const FileEditor = lazy(() =>
	import("./components/file-editor.tsx").then((module) => ({
		default: module.FileEditor,
	})),
);
const OnboardingWizard = lazy(() =>
	import("./components/onboarding/onboarding-wizard.tsx").then((module) => ({
		default: module.OnboardingWizard,
	})),
);
const RightPane = lazy(() =>
	import("./components/right-pane.tsx").then((module) => ({
		default: module.RightPane,
	})),
);
const SettingsPage = lazy(() =>
	import("./components/settings-page.tsx").then((module) => ({
		default: module.SettingsPage,
	})),
);

const loadUsageDashboard = () => import("./components/usage-dashboard.tsx");
const UsageDashboard = lazy(() =>
	loadUsageDashboard().then((module) => ({
		default: module.UsageDashboard,
	})),
);

/**
 * Animate only programmatic open/close changes. Drag resizing remains direct,
 * and the browser handles the short flex transition outside React's render loop.
 */
function useAnimatedPanelVisibility(
	panelRef: ReturnType<typeof usePanelRef>,
	elementRef: RefObject<HTMLDivElement | null>,
	open: boolean,
	expandedSize?: string,
	contextKey = "global",
) {
	const expandedSizeRef = useRef(expandedSize);
	const previousVisibilityRef = useRef<SidebarVisibilitySnapshot>(undefined);
	expandedSizeRef.current = expandedSize;
	useEffect(() => {
		const nextVisibility = { contextKey, open };
		const animate = shouldAnimateSidebarVisibility(
			previousVisibilityRef.current,
			nextVisibility,
		);
		previousVisibilityRef.current = nextVisibility;
		const panel = panelRef.current;
		if (panel === null) return;
		const element = elementRef.current;
		const shouldChange = open ? panel.isCollapsed() : !panel.isCollapsed();
		if (!shouldChange) {
			return;
		}

		if (animate) element?.classList.add("fz-sidebar-panel-motion");
		const frame = window.requestAnimationFrame(() => {
			if (open) {
				panel.expand();
				if (expandedSizeRef.current !== undefined) {
					panel.resize(expandedSizeRef.current);
				}
			} else {
				panel.collapse();
			}
		});
		const timeout = animate
			? window.setTimeout(() => {
					element?.classList.remove("fz-sidebar-panel-motion");
				}, 240)
			: undefined;
		return () => {
			window.cancelAnimationFrame(frame);
			if (timeout !== undefined) window.clearTimeout(timeout);
			element?.classList.remove("fz-sidebar-panel-motion");
		};
	}, [contextKey, elementRef, panelRef, open]);
}

function SurfaceFallback() {
	return <div className="min-h-0 flex-1 bg-background" aria-busy="true" />;
}

function ComposerFallback() {
	return <div className="h-24 shrink-0" aria-busy="true" />;
}

function TopBarFallback() {
	return <div className="h-9 shrink-0 border-b border-border" aria-hidden />;
}

function TabsFallback() {
	return <div className="h-10 shrink-0 border-b border-border" aria-hidden />;
}

function AmbientSurfaces() {
	return (
		<Suspense fallback={null}>
			<NotchTrayBridge />
			<NearbyPairingApproval />
			<PairingLinkAccept />
		</Suspense>
	);
}
/**
 * Owns cross-cutting concerns only after settings are available. Deferring
 * these subscriptions keeps the startup surface cheap and prevents fallback
 * settings from being observed as real product state.
 */
export function App() {
	const onboardingCompleted = useSettingsStore(
		(state) => state.onboardingCompleted,
	);
	return <ReadyApp onboardingCompleted={onboardingCompleted} />;
}

function ReadyApp({
	onboardingCompleted,
}: {
	readonly onboardingCompleted: boolean;
}) {
	useEffect(() => installClientBusOnlineBridge(), []);
	useEffect(() => {
		let stop: (() => void) | undefined;
		void startDesktopAnalytics().then((cleanup) => {
			stop = cleanup;
		});
		return () => stop?.();
	}, []);
	// Native Application Menu → renderer action dispatcher. Lives on the
	// root so the bindings work in every view (chat, settings, onboarding).
	useMenuShortcuts();

	// Document-level keybinding dispatcher. Walks the live keybindings store
	// on every keydown and fires the matching application command. Composer
	// and editor commands are handled by CodeMirror keymaps, so this hook
	// ignores them.
	useKeybindingDispatch();

	// Mirror privacy-safe agent, terminal, browser, recording, and indexing
	// counts to desktop services. The agent count also powers quit deferrals.
	useReportRuntimeActivity();

	// Warm the analytics surface after the shell settles so opening Usage never
	// pauses on parsing the chart renderer. The data request still starts only
	// when the user opens the surface.
	useEffect(() => {
		const timeout = window.setTimeout(() => void loadUsageDashboard(), 1_500);
		return () => window.clearTimeout(timeout);
	}, []);

	// Mirror Electron's fullscreen state into the ui store so the top bars
	// can drop the macOS traffic-light gutter.
	const setFullScreen = useUiStore((s) => s.setFullScreen);
	useEffect(() => {
		const win = window.zuse?.window;
		if (win === undefined) return;
		return win.onFullScreenChange((value) => setFullScreen(value));
	}, [setFullScreen]);

	// One-shot RPC ping so we know the bridge is alive early. Only the failure
	// is logged — the success path is silent to keep the renderer console clean.
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const client = await getRpcClient();
				await Effect.runPromise(client["ping.ping"]({}));
				markRendererStartupMilestone("rpc-connected");
			} catch (error) {
				if (cancelled) return;
				// eslint-disable-next-line no-console
				console.error("[zuse] RPC smoke test failed:", error);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const view = useUiStore((s) => s.view);
	const activeMainTab = useUiStore((s) => s.activeMainTab);
	useEffect(() => {
		trackAnalyticsScreen(
			onboardingCompleted
				? view === "settings"
					? "settings"
					: activeMainTab
				: "onboarding",
		);
	}, [activeMainTab, onboardingCompleted, view]);

	if (!onboardingCompleted) {
		return (
			<TooltipProvider>
				<AmbientSurfaces />
				<AppearanceController />
				<div className="relative flex h-dvh max-h-dvh min-h-0 w-screen overflow-hidden bg-background text-foreground">
					<Suspense fallback={<SurfaceFallback />}>
						<OnboardingWizard />
					</Suspense>
				</div>
			</TooltipProvider>
		);
	}

	if (view === "settings") {
		return (
			<TooltipProvider>
				<AmbientSurfaces />
				<AppearanceController />
				<div className="flex h-dvh max-h-dvh min-h-0 w-screen overflow-hidden bg-background text-foreground">
					<Suspense fallback={<SurfaceFallback />}>
						<SettingsPage />
					</Suspense>
				</div>
			</TooltipProvider>
		);
	}

	return (
		<TooltipProvider>
			<AmbientSurfaces />
			<AppearanceController />
			<MainShell />
		</TooltipProvider>
	);
}

/**
 * The three-pane chat shell. Owns its own layout/panel hooks so they
 * initialize on mount (i.e. only after onboarding is past). Re-mounting
 * this component on every onboarding exit guarantees the layout starts
 * from a clean state.
 */
function MainShell() {
	const activeEnvironmentId = useEnvironmentCatalogStore(
		(state) => state.activeEnvironmentId,
	);
	const folders = useWorkspaceStore((s) => s.folders);
	const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
	const selectedChatId = useChatsStore((s) => s.selectedChatId);
	const selectedCloudSummary = useCloudChatSummaryForSelection({
		chatId: selectedChatId,
		sessionId: selectedSessionId,
	});
	const selectedEnvironmentId = EnvironmentId.make(
		selectedCloudSummary?.workspaceId ?? activeEnvironmentId,
	);
	const selectedChatRef = useMemo(
		() =>
			selectedChatId === null
				? null
				: {
						environmentId: selectedEnvironmentId,
						chatId: selectedChatId,
					},
		[selectedChatId, selectedEnvironmentId],
	);
	const selectedChatKey =
		selectedChatRef === null ? null : rightPaneKey(selectedChatRef);
	const pendingCreation = useChatsStore((s) =>
		selectedChatId === null
			? null
			: (s.pendingCreationByChat[selectedChatId] ?? null),
	);
	const activeSelectedSession = useActiveSessionById(selectedSessionId);
	const selectedSession = useMemo<Session | null>(() => {
		if (activeSelectedSession !== null) return activeSelectedSession;
		if (
			selectedCloudSummary === null ||
			selectedFolderId === null ||
			selectedSessionId === null ||
			cloudSummaryActiveSessionId(selectedCloudSummary) !== selectedSessionId
		)
			return null;
		return cloudSessionPlaceholder(
			selectedCloudSummary,
			selectedFolderId,
			selectedSessionId,
		);
	}, [
		activeSelectedSession,
		selectedCloudSummary,
		selectedFolderId,
		selectedSessionId,
	]);
	const directoryStatus = useChatDirectoryStatus(
		selectedEnvironmentId,
		pendingCreation === null ? (selectedSession?.chatId ?? null) : null,
	);
	const directoryUnavailable = directoryStatus?._tag === "unavailable";
	const chatSurface = selectChatSurface({
		hasSession: selectedSessionId !== null && selectedSession !== null,
		hasPendingCreation: pendingCreation !== null,
	});
	useEffect(() => {
		if (!directoryUnavailable || selectedSession?.chatId === undefined) return;
		if (selectedChatRef !== null)
			useTerminalsStore.getState().disposeChat(selectedChatRef);
	}, [directoryUnavailable, selectedChatRef, selectedSession?.chatId]);
	const selectedFolder = selectedFolderId
		? (folders.find((f) => f.id === selectedFolderId) ?? null)
		: null;

	const activeMainTab = useUiStore((s) => s.activeMainTab);
	const usageScope = useUiStore((s) => s.usageScope);
	const openFile = useUiStore((s) => s.openFile);
	const closeFileTab = useUiStore((s) => s.closeFileTab);
	const changesTabOpen = useUiStore((s) => s.changesTabOpen);
	const closeChangesTab = useUiStore((s) => s.closeChangesTab);
	const leftSidebarOpen = useUiStore((s) => s.leftSidebarOpen);
	const setLeftSidebarOpen = useUiStore((s) => s.setLeftSidebarOpen);
	const rightSidebarOpen = useUiStore((s) =>
		selectedChatKey === null
			? false
			: (s.rightPaneLayoutByChat[selectedChatKey]?.open ?? false),
	);
	const rightSidebarWidth = useUiStore((s) =>
		selectedChatKey === null
			? DEFAULT_RIGHT_PANE_WIDTH_PERCENT
			: (s.rightPaneLayoutByChat[selectedChatKey]?.widthPercent ??
				DEFAULT_RIGHT_PANE_WIDTH_PERCENT),
	);
	const setRightSidebarOpenForChat = useUiStore(
		(s) => s.setRightSidebarOpenForChat,
	);
	const setRightSidebarWidthForChat = useUiStore(
		(s) => s.setRightSidebarWidthForChat,
	);
	const environmentSummaryOpen = useUiStore((s) => s.environmentSummaryOpen);
	const environmentSummaryFits = useMediaQuery({ min: 1180 });
	const environmentSummaryAvailable =
		environmentSummaryFits &&
		selectedSessionId !== null &&
		activeMainTab === "chat";
	const showEnvironmentSummary =
		environmentSummaryAvailable && environmentSummaryOpen;

	// Switching projects closes the file tab — its path wouldn't resolve
	// under the new project's root anyway.
	useEffect(() => {
		if (openFile === null) return;
		if (openFile.kind !== "text") return;
		if (openFileBelongsToProject(openFile, selectedFolderId)) {
			return;
		}
		closeFileTab();
	}, [selectedFolderId, openFile, closeFileTab]);

	useEffect(() => {
		if (selectedFolderId !== null) return;
		closeChangesTab();
	}, [selectedFolderId, closeChangesTab]);

	// Eagerly hydrate worktrees on project select so the active context can
	// resolve worktree paths without waiting for the chat composer to mount.
	// Without this, terminal/file-tree/branch label stay in "preparing
	// worktree" until the user opens the chat tab.
	const refreshWorktrees = useWorktreesStore((s) => s.refresh);
	useEffect(() => {
		if (selectedFolderId === null) return;
		void refreshWorktrees(selectedFolderId);
	}, [selectedFolderId, refreshWorktrees]);

	// Cmd+W in the menu dispatches `menu:close-tab` over IPC; the renderer
	// owns the close-tab logic because it knows which surface is active. If
	// the file tab is foregrounded we close that; otherwise we fall through
	// to the chat-tab archive path.
	useEffect(() => {
		const menu = window.zuse?.menu;
		if (menu === undefined) return;
		return menu.onCloseTab(() => {
			const { activeMainTab, closeFileTab, closeChangesTab, openFile } =
				useUiStore.getState();
			if (activeMainTab === "file" && openFile !== null) {
				closeFileTab();
				return;
			}
			if (activeMainTab === "changes") {
				closeChangesTab();
				return;
			}
			void closeActiveChatTab(selectedEnvironmentId);
		});
	}, [selectedEnvironmentId]);

	const emptyTabLabel = selectedFolder
		? selectedFolder.name
		: "no project selected";

	// The empty new-chat landing reads as a clean, chrome-free surface: no top
	// bar, no tab strip — just the centered composer. Keep the chrome whenever a
	// session/file is open, or when the left panel is collapsed (so the user
	// always has a way back to the projects panel + the window drag region).
	const showMainChrome =
		selectedSessionId !== null ||
		openFile !== null ||
		changesTabOpen ||
		!leftSidebarOpen;
	const showMainTabs = showMainChrome && activeMainTab !== "archives";

	// Persist the three-pane layout in localStorage so widths survive reloads.
	const { defaultLayout, onLayoutChanged } = useDefaultLayout({
		id: PANEL_GROUP_ID,
		panelIds: PANEL_IDS,
		storage: typeof window === "undefined" ? undefined : window.localStorage,
	});

	// Drive the side panels' collapsed state from `useUiStore`, animating the
	// open/close via the library's imperative resize() (see the hook). v4 has no
	// `onCollapse` prop — we peek the imperative handle through `panelRef`.
	const leftPanelRef = usePanelRef();
	const leftPanelElementRef = useRef<HTMLDivElement>(null);
	const rightPanelRef = usePanelRef();
	const rightPanelElementRef = useRef<HTMLDivElement>(null);

	// The composer floats over the timeline (glass) — measure it so the list
	// can pad its scroll range and the last message clears the overlay.
	const [composerNode, setComposerNode] = useState<HTMLDivElement | null>(null);
	const [composerInset, setComposerInset] = useState(0);
	useEffect(() => {
		if (composerNode === null) {
			setComposerInset(0);
			return;
		}
		const ro = new ResizeObserver(() => {
			setComposerInset(composerNode.offsetHeight);
		});
		ro.observe(composerNode);
		setComposerInset(composerNode.offsetHeight);
		return () => ro.disconnect();
	}, [composerNode]);
	useAnimatedPanelVisibility(
		leftPanelRef,
		leftPanelElementRef,
		leftSidebarOpen,
	);
	useAnimatedPanelVisibility(
		rightPanelRef,
		rightPanelElementRef,
		rightSidebarOpen,
		`${rightSidebarWidth}%`,
		selectedChatKey ?? "no-chat",
	);

	return (
		<div className="flex h-dvh max-h-dvh min-h-0 w-screen overflow-hidden bg-background text-foreground">
			<ActiveGitWorkspaceLease />
			<Group
				id={PANEL_GROUP_ID}
				orientation="horizontal"
				defaultLayout={defaultLayout}
				onLayoutChanged={onLayoutChanged}
				className="flex-1"
			>
				<Panel
					id="projects"
					defaultSize="232px"
					// Keep project and chat labels usable when the pane is open. A
					// collapsed pane may still rest at 0; stale near-zero expanded
					// widths from persisted layouts are clamped to this minimum.
					minSize="200px"
					maxSize="300px"
					collapsible
					collapsedSize="0%"
					panelRef={leftPanelRef}
					elementRef={leftPanelElementRef}
					onResize={(size) => {
						// Programmatic open/close emits the same resize events as a drag.
						// The store already owns that state, so reflecting an intermediate
						// animated size would immediately undo a close.
						if (
							leftPanelElementRef.current?.classList.contains(
								"fz-sidebar-panel-motion",
							)
						) {
							return;
						}
						const open = size.asPercentage > 0;
						if (open !== leftSidebarOpen) setLeftSidebarOpen(open);
					}}
				>
					<div className="flex h-full min-h-0 flex-col bg-sidebar">
						<Suspense fallback={<TopBarFallback />}>
							<TopBarLeft />
						</Suspense>
						<div className="flex min-h-0 flex-1 flex-col">
							<Suspense fallback={<SurfaceFallback />}>
								<ProjectsSidebar />
							</Suspense>
						</div>
					</div>
				</Panel>
				<Separator className="w-px bg-sidebar-border transition-colors hover:bg-input active:bg-muted-foreground/40" />
				<Panel id="main" minSize="30%">
					<main className="flex h-full min-h-0 min-w-0 flex-col bg-background">
						{showMainChrome ? (
							<Suspense fallback={<TopBarFallback />}>
								<TopBarMain />
							</Suspense>
						) : null}
						<Suspense fallback={null}>
							<UpdateBanner />
							<ProviderUpdatesToast />
						</Suspense>
						{showMainTabs ? (
							<Suspense fallback={<TabsFallback />}>
								<MainTabs
									environmentId={selectedEnvironmentId}
									projectId={selectedFolderId}
									emptyLabel={emptyTabLabel}
								/>
							</Suspense>
						) : null}
						<div
							hidden={activeMainTab !== "chat"}
							className="flex min-h-0 flex-1 flex-col"
						>
							{chatSurface === "session" &&
							selectedSessionId !== null &&
							selectedSession !== null ? (
								// Render the chat as soon as the session exists — even while
								// its worktree is still branching or the provider is booting.
								// All that progress is surfaced inline by `WorktreeSetupCard`
								// at the top of the timeline, with the composer pinned at the
								// bottom (no full-screen takeover).
								<div className="chat-session-layout relative flex min-h-0 min-w-0 flex-1">
									<div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
										<Suspense fallback={<SurfaceFallback />}>
											<ChatView
												sessionId={selectedSessionId}
												environmentId={selectedEnvironmentId}
												session={selectedSession}
												endInset={composerInset}
											/>
										</Suspense>
										<div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 px-[var(--chat-row-gutter)]">
											{/* Keep the fade on the full transcript plane. Code blocks
											    can extend beyond the centered composer column. */}
											<div
												data-chat-composer-fade
												aria-hidden
												className="pointer-events-none absolute inset-x-0 -top-10 bottom-0 -z-10 backdrop-blur-md [mask-image:linear-gradient(to_bottom,transparent,black_45%)]"
											/>
											<div
												ref={setComposerNode}
												className="pointer-events-auto mx-auto w-full max-w-[var(--chat-reading-column)] pt-1"
											>
												<Suspense fallback={null}>
													<CloudConnectionNotice />
												</Suspense>
												<Suspense fallback={null}>
													<CliUpgradeBanner
														providerId={selectedSession.providerId}
														constrain={false}
													/>
												</Suspense>
												{directoryUnavailable ? (
													<Suspense fallback={null}>
														<DirectoryUnavailableBanner />
													</Suspense>
												) : null}
												<Suspense fallback={<ComposerFallback />}>
													<ChatComposer
														key={selectedSession.id}
														session={selectedSession}
														environmentId={selectedEnvironmentId}
														constrain={false}
														directoryUnavailable={directoryUnavailable}
													/>
												</Suspense>
											</div>
										</div>
									</div>
									{environmentSummaryAvailable ? (
										<div
											className={`pointer-events-none absolute right-2 -top-2 z-20 max-h-[calc(100%+1rem)] transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.165,0.84,0.44,1)] motion-reduce:transition-none ${
												showEnvironmentSummary
													? "translate-x-0 opacity-100"
													: "translate-x-2 opacity-0"
											}`}
											aria-hidden={!showEnvironmentSummary}
											inert={!showEnvironmentSummary}
										>
											<Suspense fallback={null}>
												<EnvironmentSummary />
											</Suspense>
										</div>
									) : null}
								</div>
							) : chatSurface === "pending" && pendingCreation !== null ? (
								<PendingChatCreationSurface creation={pendingCreation} />
							) : (
								<Suspense fallback={<SurfaceFallback />}>
									<ChatLanding />
								</Suspense>
							)}
						</div>
						<div
							hidden={activeMainTab !== "archives"}
							className="flex min-h-0 flex-1 flex-col"
						>
							{activeMainTab === "archives" && (
								<Suspense fallback={<SurfaceFallback />}>
									<ArchivedChatsPage
										projectId={selectedFolderId}
										projectName={
											selectedFolder?.name ?? "No repository selected"
										}
									/>
								</Suspense>
							)}
						</div>
						<div
							hidden={activeMainTab !== "usage"}
							className="flex min-h-0 flex-1 flex-col"
						>
							{activeMainTab === "usage" && (
								<Suspense fallback={<SurfaceFallback />}>
									<UsageDashboard
										environmentId={EnvironmentId.make(activeEnvironmentId)}
										projectId={
											usageScope === "project" ? selectedFolderId : null
										}
										availableProjectId={selectedFolderId}
										scopeLabel={
											usageScope === "project"
												? (selectedFolder?.name ?? "This project")
												: "All projects"
										}
									/>
								</Suspense>
							)}
						</div>
						{openFile !== null && (
							<div
								hidden={activeMainTab !== "file"}
								className="flex min-h-0 flex-1 flex-col"
							>
								<Suspense fallback={<SurfaceFallback />}>
									{directoryUnavailable ? (
										<DirectoryUnavailableSurface label="Files are unavailable because this directory was deleted." />
									) : (
										<FileEditor />
									)}
								</Suspense>
							</div>
						)}
						{changesTabOpen ? (
							<div
								hidden={activeMainTab !== "changes"}
								className="flex min-h-0 flex-1 flex-col"
							>
								<Suspense fallback={<SurfaceFallback />}>
									{directoryUnavailable ? (
										<DirectoryUnavailableSurface label="Changes are unavailable because this directory was deleted." />
									) : (
										<ChangesReview />
									)}
								</Suspense>
							</div>
						) : null}
					</main>
				</Panel>
				<Separator className="w-px bg-sidebar-border transition-colors hover:bg-input active:bg-muted-foreground/40" />
				<Panel
					id="files"
					defaultSize="22%"
					// Keep an opened dock useful. Older persisted layouts may contain a
					// near-zero expanded width from when this minimum was 0; the panel
					// library clamps those layouts to this value on launch and reopen.
					minSize="360px"
					maxSize="55%"
					collapsible
					collapsedSize="0%"
					panelRef={rightPanelRef}
					elementRef={rightPanelElementRef}
					onResize={(size, _id, prev) => {
						// Ignore the initial mount call (prev === undefined). The right
						// dock defaults to closed (`rightSidebarOpen: false`); the
						// persisted/default panel width would otherwise fire here and
						// flip the sidebar open before the collapse effect runs.
						if (prev === undefined) return;
						if (selectedChatRef === null) return;
						if (
							rightPanelElementRef.current?.classList.contains(
								"fz-sidebar-panel-motion",
							)
						) {
							return;
						}
						const open = size.asPercentage > 0;
						if (open !== rightSidebarOpen) {
							setRightSidebarOpenForChat(selectedChatRef, open);
						}
						if (open && size.asPercentage !== rightSidebarWidth) {
							setRightSidebarWidthForChat(selectedChatRef, size.asPercentage);
						}
					}}
				>
					<div className="flex h-full min-h-0 flex-col bg-sidebar">
						<Suspense fallback={<TopBarFallback />}>
							<TopBarRight />
						</Suspense>
						<div className="flex min-h-0 flex-1 flex-col">
							{shouldMountRightPane(rightSidebarOpen) ? (
								<Suspense fallback={<SurfaceFallback />}>
									<RightPane directoryUnavailable={directoryUnavailable} />
								</Suspense>
							) : null}
						</div>
					</div>
				</Panel>
			</Group>
			<Suspense fallback={null}>
				<SidebarPeekTrigger />
				<SidebarPeekOverlay />
				<ChatSwitcher />
			</Suspense>
		</div>
	);
}

function DirectoryUnavailableSurface({ label }: { readonly label: string }) {
	return (
		<div
			role="status"
			className="grid min-h-0 flex-1 place-items-center px-6 text-center text-sm text-muted-foreground"
		>
			{label}
		</div>
	);
}
