import { Effect } from "effect";
import { lazy, Suspense, useEffect, useState } from "react";
import {
	Group,
	Panel,
	Separator,
	useDefaultLayout,
	usePanelRef,
} from "react-resizable-panels";
import { ChatLanding } from "./components/chat-landing.tsx";
import { ChatSwitcher } from "./components/chat-switcher.tsx";
import { CliUpgradeBanner } from "./components/cli-upgrade-banner.tsx";
import { EnvironmentSummary } from "./components/environment-summary.tsx";
import { closeActiveChatTab, MainTabs } from "./components/main-tabs.tsx";
import { NotchTrayBridge } from "./components/notch-tray-bridge.tsx";
import { ProjectsSidebar } from "./components/projects-sidebar";
import { ProviderUpdatesToast } from "./components/provider-updates-toast.tsx";
import {
	SidebarPeekOverlay,
	SidebarPeekTrigger,
} from "./components/sidebar-peek.tsx";
import { SponsorBar } from "./components/sponsor-bar.tsx";
import { TopBarLeft, TopBarMain, TopBarRight } from "./components/top-bar.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { UpdateBanner } from "./components/update-banner.tsx";
import { useKeybindingDispatch } from "./hooks/use-keybinding-dispatch.ts";
import { useMediaQuery } from "./hooks/use-media-query.ts";
import { useMenuShortcuts } from "./hooks/use-menu-shortcuts.ts";
import { useReportRunningAgents } from "./hooks/use-report-running-agents.ts";
import { AppearanceController } from "./lib/appearance.tsx";
import { getRpcClient } from "./lib/rpc-client.ts";
import { useAuthStore } from "./store/auth.ts";
import { useKeybindingsStore } from "./store/keybindings.ts";
import { usePermissionsStore } from "./store/permissions.ts";
import { useQueueHydrationStore } from "./store/queue-hydration.ts";
import { getSessionById, useSessionsStore } from "./store/sessions.ts";
import { useSettingsStore } from "./store/settings.ts";
import { useUiStore } from "./store/ui.ts";
import { useWorkspaceStore } from "./store/workspace.ts";
import { useWorktreesStore } from "./store/worktrees.ts";

const PANEL_GROUP_ID = "zuse.shell.v3";
const PANEL_IDS = ["projects", "main", "files"];

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
const UsageDashboard = lazy(() =>
	import("./components/usage-dashboard.tsx").then((module) => ({
		default: module.UsageDashboard,
	})),
);

/**
 * Sidebars snap to their requested state. These controls are used frequently;
 * avoiding a resize loop keeps navigation responsive under stream pressure.
 */
function usePanelCollapse(
	panelRef: ReturnType<typeof usePanelRef>,
	open: boolean,
) {
	useEffect(() => {
		const panel = panelRef.current;
		if (panel === null) return;
		if (open && panel.isCollapsed()) panel.expand();
		if (!open && !panel.isCollapsed()) panel.collapse();
	}, [panelRef, open]);
}

function SurfaceFallback() {
	return <div className="min-h-0 flex-1 bg-background" aria-busy="true" />;
}

function ComposerFallback() {
	return <div className="h-24 shrink-0" aria-busy="true" />;
}
/**
 * Root component. Owns only the cross-cutting concerns that need to run in
 * every mode (permissions stream, fullscreen sync, onboarding gate). The
 * heavy three-pane shell lives in `MainShell` so its layout hooks don't
 * initialize while the onboarding wizard is on screen — re-mounting it on
 * exit is what gives us a clean shell each time.
 */
export function App() {
	// Cross-cutting subscriptions that should run regardless of view.
	const startPermissionsStream = usePermissionsStore((s) => s.start);
	useEffect(() => {
		startPermissionsStream();
	}, [startPermissionsStream]);

	// WorkOS auth: subscribe to session changes + cold-load the current session.
	// Optional (no gate) — the sidebar account control, onboarding step, and
	// settings panel all render off this state.
	const startAuthStream = useAuthStore((s) => s.start);
	const hydrateAuth = useAuthStore((s) => s.hydrate);
	useEffect(() => {
		startAuthStream();
		void hydrateAuth();
	}, [startAuthStream, hydrateAuth]);

	// Native Application Menu → renderer action dispatcher. Lives on the
	// root so the bindings work in every view (chat, settings, onboarding).
	useMenuShortcuts();

	// Document-level keybinding dispatcher. Walks the live keybindings store
	// on every keydown and fires the matching application command. Composer
	// and editor commands are handled by CodeMirror keymaps, so this hook
	// ignores them.
	useKeybindingDispatch();

	// Mirror the running-agent count to main so the before-quit guard and the
	// "quit/restart when idle" deferrals have a live value.
	useReportRunningAgents();

	// Hydrate settings + keybindings from the on-disk config store. Each call is
	// idempotent; subsequent emits flow through the RPC streams maintained by the
	// stores themselves.
	const hydrateSettings = useSettingsStore((s) => s.hydrate);
	const hydrateKeybindings = useKeybindingsStore((s) => s.hydrate);
	useEffect(() => {
		void hydrateSettings();
		void hydrateKeybindings();
	}, [hydrateSettings, hydrateKeybindings]);

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

	const onboardingCompleted = useSettingsStore((s) => s.onboardingCompleted);
	const view = useUiStore((s) => s.view);

	if (!onboardingCompleted) {
		return (
			<TooltipProvider>
				<NotchTrayBridge />
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
				<NotchTrayBridge />
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
			<NotchTrayBridge />
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
	const folders = useWorkspaceStore((s) => s.folders);
	const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
	const selectedSession = useSessionsStore((s) => {
		if (s.selectedSessionId === null) return null;
		return getSessionById(s.selectedSessionId);
	});
	const selectedQueueHydrated = useQueueHydrationStore((state) =>
		selectedSessionId === null
			? false
			: state.hydratedBySession[selectedSessionId] === true,
	);
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
	const rightSidebarOpen = useUiStore((s) => s.rightSidebarOpen);
	const setRightSidebarOpen = useUiStore((s) => s.setRightSidebarOpen);
	const environmentSummaryOpen = useUiStore((s) => s.environmentSummaryOpen);
	const environmentSummaryFits = useMediaQuery({ min: 1180 });
	const environmentSummaryAvailable =
		environmentSummaryFits &&
		selectedSessionId !== null &&
		activeMainTab === "chat";
	const showEnvironmentSummary =
		environmentSummaryAvailable && environmentSummaryOpen && !rightSidebarOpen;

	// Switching projects closes the file tab — its path wouldn't resolve
	// under the new project's root anyway.
	useEffect(() => {
		if (openFile === null) return;
		if (openFile.kind !== "text") return;
		if (selectedFolderId !== null && openFile.folderId === selectedFolderId) {
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
			void closeActiveChatTab();
		});
	}, []);

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
	const rightPanelRef = usePanelRef();

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
	usePanelCollapse(leftPanelRef, leftSidebarOpen);
	usePanelCollapse(rightPanelRef, rightSidebarOpen);

	return (
		<div className="flex h-dvh max-h-dvh min-h-0 w-screen overflow-hidden text-foreground">
			<Group
				id={PANEL_GROUP_ID}
				orientation="horizontal"
				defaultLayout={defaultLayout}
				onLayoutChanged={onLayoutChanged}
				className="flex-1"
			>
				<Panel
					id="projects"
					defaultSize="20%"
					// Keep project and chat labels usable when the pane is open. A
					// collapsed pane may still rest at 0; stale near-zero expanded
					// widths from persisted layouts are clamped to this minimum.
					minSize="280px"
					maxSize="40%"
					collapsible
					collapsedSize="0%"
					panelRef={leftPanelRef}
					onResize={(size) => {
						const open = size.asPercentage > 0;
						if (open !== leftSidebarOpen) setLeftSidebarOpen(open);
					}}
				>
					<div className="flex h-full min-h-0 flex-col bg-background/70">
						<TopBarLeft />
						<div className="flex min-h-0 flex-1 flex-col">
							<ProjectsSidebar />
						</div>
					</div>
				</Panel>
				<Separator className="w-px bg-border transition-colors hover:bg-foreground/20 active:bg-foreground/30" />
				<Panel id="main" minSize="30%">
					<main className="flex h-full min-h-0 min-w-0 flex-col bg-background">
						{showMainChrome ? <TopBarMain /> : null}
						<UpdateBanner />
						<ProviderUpdatesToast />
						{showMainTabs ? (
							<MainTabs
								projectId={selectedFolderId}
								emptyLabel={emptyTabLabel}
							/>
						) : null}
						<div
							hidden={activeMainTab !== "chat"}
							className="flex min-h-0 flex-1 flex-col"
						>
							{selectedSessionId !== null && selectedSession !== null ? (
								// Render the chat as soon as the session exists — even while
								// its worktree is still branching or the provider is booting.
								// All that progress is surfaced inline by `WorktreeSetupCard`
								// at the top of the timeline, with the composer pinned at the
								// bottom (no full-screen takeover).
								<div className="flex min-h-0 min-w-0 flex-1 px-3">
									<div className="relative mx-auto flex min-h-0 min-w-0 w-full max-w-4xl flex-1 flex-col">
										<Suspense fallback={<SurfaceFallback />}>
											<ChatView
												sessionId={selectedSessionId}
												endInset={composerInset}
											/>
										</Suspense>
										<div
											ref={setComposerNode}
											className="absolute inset-x-0 bottom-0 z-30"
										>
											{/* Fade the timeline out beneath and just above the
											    composer so scrolled-past text melts away instead
											    of ending in a hard edge. */}
											<div
												aria-hidden
												className="pointer-events-none absolute inset-x-0 -top-10 bottom-0 -z-10 backdrop-blur-md [mask-image:linear-gradient(to_bottom,transparent,black_45%)]"
											/>
											<CliUpgradeBanner
												providerId={selectedSession.providerId}
												constrain={false}
											/>
											{selectedQueueHydrated ? (
												<Suspense fallback={<ComposerFallback />}>
													<ChatComposer
														key={selectedSession.id}
														session={selectedSession}
														constrain={false}
													/>
												</Suspense>
											) : (
												<ComposerFallback />
											)}
										</div>
									</div>
									{environmentSummaryAvailable ? (
										<div
											className={`shrink-0 overflow-hidden transition-[width,opacity] duration-150 ease-[cubic-bezier(0.165,0.84,0.44,1)] motion-reduce:transition-none ${
												showEnvironmentSummary
													? "w-[18.75rem] opacity-100"
													: "w-0 opacity-0"
											}`}
											aria-hidden={!showEnvironmentSummary}
											inert={!showEnvironmentSummary}
										>
											<div
												className={`w-[18.75rem] transition-transform duration-150 ease-[cubic-bezier(0.165,0.84,0.44,1)] motion-reduce:transition-none ${
													showEnvironmentSummary
														? "translate-x-0"
														: "translate-x-3"
												}`}
											>
												<EnvironmentSummary />
											</div>
										</div>
									) : null}
								</div>
							) : (
								<ChatLanding />
							)}
							<SponsorBar sessionId={selectedSessionId} />
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
									<FileEditor />
								</Suspense>
							</div>
						)}
						{changesTabOpen ? (
							<div
								hidden={activeMainTab !== "changes"}
								className="flex min-h-0 flex-1 flex-col"
							>
								<Suspense fallback={<SurfaceFallback />}>
									<ChangesReview />
								</Suspense>
							</div>
						) : null}
					</main>
				</Panel>
				<Separator className="w-px bg-border transition-colors hover:bg-foreground/20 active:bg-foreground/30" />
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
					onResize={(size, _id, prev) => {
						// Ignore the initial mount call (prev === undefined). The right
						// dock defaults to closed (`rightSidebarOpen: false`); the
						// persisted/default panel width would otherwise fire here and
						// flip the sidebar open before the collapse effect runs.
						if (prev === undefined) return;
						const open = size.asPercentage > 0;
						if (open !== rightSidebarOpen) setRightSidebarOpen(open);
					}}
				>
					<div className="flex h-full min-h-0 flex-col bg-background">
						<TopBarRight />
						<div className="flex min-h-0 flex-1 flex-col">
							{rightSidebarOpen ? (
								<Suspense fallback={<SurfaceFallback />}>
									<RightPane />
								</Suspense>
							) : null}
						</div>
					</div>
				</Panel>
			</Group>
			<SidebarPeekTrigger />
			<SidebarPeekOverlay />
			<ChatSwitcher />
		</div>
	);
}
