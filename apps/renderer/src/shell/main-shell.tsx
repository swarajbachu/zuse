import { isCloudProjectFolder } from "../lib/cloud-project-folders.ts";
import { SurfaceFallback } from "./surface-fallback.tsx";
import "@zuse/i18n/english/shell";

import { EnvironmentId, type Session } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";

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

import { ChatLoadingFallback } from "../components/chat-loading-fallback.tsx";
import { CloudConnectionNotice } from "../components/cloud-connection-notice.tsx";
import { PendingChatCreationSurface } from "../components/pending-chat-creation.tsx";
import { useChatDirectoryStatus } from "../hooks/use-chat-directory-status.ts";
import { useMediaQuery } from "../hooks/use-media-query.ts";
import { selectChatSurface } from "../lib/chat-surface-selection.ts";
import { closeActiveChatTab } from "../lib/close-chat-tab.ts";
import {
	cloudRuntimeProjectId,
	resolveCloudSession,
} from "../lib/cloud-session-selection.ts";
import {
	cloudSummaryActiveSessionId,
	registerCloudChat,
} from "../lib/cloud-workspace-catalog.ts";
import { cloudTranscriptActivation } from "../lib/cloud-workspace-lifecycle.ts";
import {
	cloudSessionPlaceholder,
	useCloudChatSummaryForSelection,
} from "../lib/cloud-workspaces.ts";
import {
	useActiveSessionById,
	useEnvironmentChat,
} from "../lib/environment-entity-hooks.ts";
import { useEnvironmentShellResource } from "../lib/environment-shell-client-bus.ts";
import { useGitWorkspaceResource } from "../lib/git-workspace-client-bus.ts";
import { rendererWorkspaceSnapshot } from "../lib/renderer-workspace.ts";
import { useSessionTimelineResource } from "../lib/session-timeline-client-bus.ts";

import {
	type SidebarVisibilitySnapshot,
	shouldAnimateSidebarVisibility,
} from "../lib/sidebar-panel-motion.ts";

import { shouldMountRightPane } from "../shell/right-pane-lifecycle.ts";

import { useActiveContext } from "../store/active-workspace.ts";

import { useChatsStore } from "../store/chats.ts";

import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";

import { useSessionsStore } from "../store/sessions.ts";

import { useTerminalsStore } from "../store/terminals.ts";

import {
	DEFAULT_RIGHT_PANE_WIDTH_PERCENT,
	openFileBelongsToProject,
	rightPaneKey,
	useUiStore,
} from "../store/ui.ts";

import { useWorkspaceStore } from "../store/workspace.ts";

import { useWorktreesStore } from "../store/worktrees.ts";

const PANEL_GROUP_ID = "zuse.shell.v3";

const PANEL_IDS = ["projects", "main", "files"];

function ActiveGitWorkspaceLease() {
	const context = useActiveContext();
	const scratch = useWorkspaceStore(
		(s) =>
			context.status === "ready" &&
			s.folders.some(
				(folder) => folder.id === context.folderId && folder.kind === "scratch",
			),
	);
	const ref = useMemo(
		() =>
			context.status === "ready" && !scratch
				? {
						environmentId: context.environmentId,
						folderId: context.folderId,
						worktreeId: context.worktreeId,
						rootPath: context.rootPath,
					}
				: null,
		[context, scratch],
	);
	useGitWorkspaceResource(ref, "connect");
	return null;
}

const MainTabs = lazy(() =>
	import("../components/main-tabs.tsx").then((module) => ({
		default: module.MainTabs,
	})),
);

const ChatLanding = lazy(() =>
	import("../components/chat-landing.tsx").then((module) => ({
		default: module.ChatLanding,
	})),
);

const ProjectsSidebar = lazy(() =>
	import("../components/projects-sidebar.tsx").then((module) => ({
		default: module.ProjectsSidebar,
	})),
);

const TopBarLeft = lazy(() =>
	import("../components/top-bar.tsx").then((module) => ({
		default: module.TopBarLeft,
	})),
);

const TopBarMain = lazy(() =>
	import("../components/top-bar.tsx").then((module) => ({
		default: module.TopBarMain,
	})),
);

const FileSearch = lazy(() =>
	import("../components/file-search.tsx").then((module) => ({
		default: module.FileSearch,
	})),
);

const CliUpgradeBanner = lazy(() =>
	import("../components/cli-upgrade-banner.tsx").then((module) => ({
		default: module.CliUpgradeBanner,
	})),
);

const DirectoryUnavailableBanner = lazy(() =>
	import("../components/directory-unavailable-banner.tsx").then((module) => ({
		default: module.DirectoryUnavailableBanner,
	})),
);

const EnvironmentSummary = lazy(() =>
	import("../components/environment-summary.tsx").then((module) => ({
		default: module.EnvironmentSummary,
	})),
);

const ProviderUpdatesToast = lazy(() =>
	import("../components/provider-updates-toast.tsx").then((module) => ({
		default: module.ProviderUpdatesToast,
	})),
);

const SidebarPeekOverlay = lazy(() =>
	import("../components/sidebar-peek.tsx").then((module) => ({
		default: module.SidebarPeekOverlay,
	})),
);

const SidebarPeekTrigger = lazy(() =>
	import("../components/sidebar-peek.tsx").then((module) => ({
		default: module.SidebarPeekTrigger,
	})),
);

const UpdateBanner = lazy(() =>
	import("../components/update-banner.tsx").then((module) => ({
		default: module.UpdateBanner,
	})),
);

const PluginsPage = lazy(() =>
	import("../components/plugins/plugins-page.tsx").then((module) => ({
		default: module.PluginsPage,
	})),
);
const ArchivedChatsPage = lazy(() =>
	import("../components/archived-chats-page.tsx").then((module) => ({
		default: module.ArchivedChatsPage,
	})),
);

const ChatComposer = lazy(() =>
	import("../components/chat-composer.tsx").then((module) => ({
		default: module.ChatComposer,
	})),
);

const ChatView = lazy(() =>
	import("../components/chat-view.tsx").then((module) => ({
		default: module.ChatView,
	})),
);

const ChangesReview = lazy(() =>
	import("../components/changes-review.tsx").then((module) => ({
		default: module.ChangesReview,
	})),
);

const BottomTerminalDock = lazy(() =>
	import("../components/bottom-terminal-dock.tsx").then((module) => ({
		default: module.BottomTerminalDock,
	})),
);
const FileEditor = lazy(() =>
	import("../components/file-editor.tsx").then((module) => ({
		default: module.FileEditor,
	})),
);

const RightPane = lazy(() =>
	import("../components/right-pane.tsx").then((module) => ({
		default: module.RightPane,
	})),
);

const loadUsageDashboard = () => import("../components/usage-dashboard.tsx");

const UsageDashboard = lazy(() =>
	loadUsageDashboard().then((module) => ({
		default: module.UsageDashboard,
	})),
);

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
				if (expandedSizeRef.current !== undefined) {
					panel.resize(expandedSizeRef.current);
				}

				panel.expand();
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

function ComposerFallback() {
	return <div className="h-24 shrink-0" aria-busy="true" />;
}

function TopBarFallback() {
	return <div className="h-9 shrink-0 border-b border-border" aria-hidden />;
}

function TabsFallback() {
	return <div className="h-10 shrink-0 border-b border-border" aria-hidden />;
}

/**
 * The three-pane chat shell. Owns its own layout/panel hooks so they
 * initialize on mount (i.e. only after onboarding is past). Re-mounting
 * this component on every onboarding exit guarantees the layout starts
 * from a clean state.
 */
export function MainShell() {
	const activeContext = useActiveContext();
	const { message: uiMessage } = useUiMessages(["shell"]);

	const activeEnvironmentId = useEnvironmentCatalogStore(
		(state) => state.activeEnvironmentId,
	);
	const folders = useWorkspaceStore((s) => s.folders);
	const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
	const storedSessionId = useSessionsStore((s) => s.selectedSessionId);
	const selectedChatId = useChatsStore((s) => s.selectedChatId);
	const landingRevision = useChatsStore((s) => s.landingRevision);
	const selectedCloudSummary = useCloudChatSummaryForSelection({
		chatId: selectedChatId,
		sessionId: storedSessionId,
	});
	const selectedEnvironmentId = EnvironmentId.make(
		selectedCloudSummary?.workspaceId ?? activeEnvironmentId,
	);

	const cloudShell = useEnvironmentShellResource(
		selectedCloudSummary === null ? null : selectedEnvironmentId,
		selectedCloudSummary === null
			? "cache-only"
			: cloudTranscriptActivation(selectedCloudSummary),
	);
	const cloudSession = useMemo(
		() =>
			selectedCloudSummary === null
				? null
				: resolveCloudSession(
						selectedCloudSummary,
						cloudShell.data,
						storedSessionId,
					),
		[selectedCloudSummary, cloudShell.data, storedSessionId],
	);
	const coldTimelineRef = useMemo(() => {
		if (selectedCloudSummary === null || cloudSession !== null) return null;
		const sessionId =
			storedSessionId ?? cloudSummaryActiveSessionId(selectedCloudSummary);
		return sessionId === null
			? null
			: {
					environmentId: EnvironmentId.make(selectedCloudSummary.workspaceId),
					sessionId,
				};
	}, [selectedCloudSummary, cloudSession, storedSessionId]);

	useSessionTimelineResource(coldTimelineRef, "sync");
	useEffect(() => {
		if (
			selectedCloudSummary === null ||
			cloudTranscriptActivation(selectedCloudSummary) === "sync" ||
			selectedFolderId !== null ||
			cloudShell.data === null
		)
			return;
		const folderId = cloudRuntimeProjectId(
			selectedCloudSummary,
			cloudShell.data,
		);
		if (folderId === null) return;
		const workspace = rendererWorkspaceSnapshot();
		let active = true;
		const isCurrent = () =>
			active &&
			rendererWorkspaceSnapshot() === workspace &&
			useChatsStore.getState().selectedChatId === selectedCloudSummary.chatId &&
			useWorkspaceStore.getState().selectedFolderId === null;
		registerCloudChat(selectedCloudSummary, folderId);
		void useEnvironmentCatalogStore
			.getState()
			.activateTransient(selectedCloudSummary.workspaceId, cloudShell.data, {
				folderId,
				chatId: selectedCloudSummary.chatId,
				isCurrent,
			})
			.catch((cause: unknown) => {
				if (isCurrent())
					useChatsStore.setState({
						error:
							cause instanceof Error
								? cause.message
								: "Could not open the cloud checkout.",
					});
			});
		return () => {
			active = false;
		};
	}, [selectedCloudSummary, selectedFolderId, cloudShell.data]);
	const selectedSessionId =
		cloudSession?.id ??
		(selectedCloudSummary === null
			? storedSessionId
			: cloudSummaryActiveSessionId(selectedCloudSummary));
	useEffect(() => {
		if (
			cloudSession === null ||
			selectedFolderId === null ||
			selectedChatId === null ||
			cloudSession.id === storedSessionId
		)
			return;
		if (useChatsStore.getState().selectedChatId !== selectedChatId) return;
		useSessionsStore.setState((state) => ({
			selectedSessionId: cloudSession.id,
			selectedSessionByProject: {
				...state.selectedSessionByProject,
				[selectedFolderId]: cloudSession.id,
			},
		}));
	}, [cloudSession, selectedFolderId, selectedChatId, storedSessionId]);
	const selectedChatRef = useMemo(
		() =>
			selectedChatId === null
				? null
				: {
						environmentId: selectedEnvironmentId,
						chatId: selectedChatId,
					},
		[selectedChatId, selectedEnvironmentId, uiMessage],
	);
	const selectedChatKey =
		selectedChatRef === null ? null : rightPaneKey(selectedChatRef);
	const selectedChat = useEnvironmentChat(selectedChatRef);
	const pendingCreation = useChatsStore((s) =>
		selectedChatId === null
			? null
			: (s.pendingCreationByChat[selectedChatId] ?? null),
	);
	const activeSelectedSession = useActiveSessionById(selectedSessionId);
	const selectedSession = useMemo<Session | null>(() => {
		if (cloudSession !== null) return cloudSession;
		if (selectedCloudSummary === null && activeSelectedSession !== null)
			return activeSelectedSession;
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
		cloudSession,
		selectedCloudSummary,
		selectedFolderId,
		selectedSessionId,
		uiMessage,
	]);
	const directoryStatus = useChatDirectoryStatus(
		selectedEnvironmentId,
		pendingCreation === null ? (selectedSession?.chatId ?? null) : null,
	);
	const directoryUnavailable = directoryStatus?._tag === "unavailable";
	const chatSurface = selectChatSurface({
		hasSession: selectedSessionId !== null && selectedSession !== null,
		hasPendingCreation: pendingCreation !== null,
		hasCloudSelection: selectedCloudSummary !== null,
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
	const compactWorkspace = useMediaQuery({ max: 900 });
	const environmentSummaryAvailable =
		selectedSessionId !== null &&
		activeMainTab === "chat" &&
		selectedFolder?.kind !== "scratch";
	const showEnvironmentSummary =
		environmentSummaryAvailable && environmentSummaryOpen;

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

	const refreshWorktrees = useWorktreesStore((s) => s.refresh);
	useEffect(() => {
		if (
			selectedFolderId === null ||
			isCloudProjectFolder(selectedFolderId) ||
			folders.some(
				(folder) => folder.id === selectedFolderId && folder.kind === "scratch",
			)
		)
			return;
		void refreshWorktrees(selectedFolderId);
	}, [selectedFolderId, folders, refreshWorktrees]);

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

	const emptyTabLabel =
		selectedSession?.title ||
		selectedCloudSummary?.title ||
		selectedFolder?.name ||
		"no project selected";

	const showMainChrome =
		selectedCloudSummary !== null ||
		selectedSessionId !== null ||
		openFile !== null ||
		changesTabOpen ||
		!leftSidebarOpen;
	const fullWidthPage =
		activeMainTab === "archives" ||
		activeMainTab === "usage" ||
		activeMainTab === "plugins";
	const showMainTabs = showMainChrome && !fullWidthPage;

	const { defaultLayout, onLayoutChanged } = useDefaultLayout({
		id: PANEL_GROUP_ID,
		panelIds: PANEL_IDS,
		storage: typeof window === "undefined" ? undefined : window.localStorage,
	});

	const leftPanelRef = usePanelRef();
	const leftPanelElementRef = useRef<HTMLDivElement>(null);
	const rightPanelRef = usePanelRef();
	const rightPanelElementRef = useRef<HTMLDivElement>(null);

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
		rightSidebarOpen && !fullWidthPage,
		`${rightSidebarWidth}%`,
		selectedChatKey ?? "no-chat",
	);

	return (
		<div className="workspace-shell flex h-dvh max-h-dvh min-h-0 w-screen overflow-hidden bg-sidebar text-foreground">
			<ActiveGitWorkspaceLease />
			<Group
				id={PANEL_GROUP_ID}
				orientation="horizontal"
				defaultLayout={defaultLayout}
				onLayoutChanged={onLayoutChanged}
				className="workspace-panel-group flex-1"
			>
				<Panel
					id="projects"
					defaultSize="232px"
					minSize="200px"
					maxSize="300px"
					collapsible
					collapsedSize="0%"
					panelRef={leftPanelRef}
					elementRef={leftPanelElementRef}
					onResize={(size) => {
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
					<div className="workspace-column workspace-left-column">
						<div className="workspace-surface flex min-h-0 flex-1 flex-col">
							<Suspense fallback={<TopBarFallback />}>
								<TopBarLeft />
							</Suspense>
							<div className="flex min-h-0 flex-1 flex-col">
								<Suspense fallback={<SurfaceFallback />}>
									<ProjectsSidebar />
								</Suspense>
							</div>
						</div>
					</div>
				</Panel>
				<Separator className="workspace-separator" />
				<Panel id="main" minSize="30%">
					<div className="workspace-column">
						<main className="workspace-main flex min-h-0 min-w-0 flex-1 flex-col">
							{showMainChrome ? (
								<Suspense fallback={<TopBarFallback />}>
									<TopBarMain />
								</Suspense>
							) : null}
							<div className="workspace-surface flex min-h-0 min-w-0 flex-1 flex-col">
								<Suspense fallback={null}>
									<UpdateBanner />
									<ProviderUpdatesToast />
								</Suspense>
								{showMainTabs ? (
									<Suspense fallback={<TabsFallback />}>
										<MainTabs
											environmentId={selectedEnvironmentId}
											projectId={selectedSession?.projectId ?? selectedFolderId}
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
										<div className="chat-session-layout relative flex min-h-0 min-w-0 flex-1">
											<div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
												<Suspense fallback={<ChatLoadingFallback />}>
													<ChatView
														sessionId={selectedSessionId}
														environmentId={selectedEnvironmentId}
														session={selectedSession}
														endInset={composerInset}
													/>
												</Suspense>
												<div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 px-[var(--chat-row-gutter)]">
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
															{selectedChat?.readOnly === true ? (
																<p
																	role="status"
																	className="py-3 text-center text-xs text-muted-foreground"
																>
																	{uiMessage("shell:shared_session_read_only")}
																</p>
															) : (
																<ChatComposer
																	key={selectedSession.id}
																	session={selectedSession}
																	environmentId={selectedEnvironmentId}
																	constrain={false}
																	directoryUnavailable={directoryUnavailable}
																/>
															)}
														</Suspense>
													</div>
												</div>
											</div>
											{environmentSummaryAvailable ? (
												<div
													className={`pointer-events-none absolute right-2 -top-8 z-20 max-h-[calc(100%+2rem)] transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.165,0.84,0.44,1)] motion-reduce:transition-none ${
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
									) : chatSurface === "cloud-pending" ? (
										<ChatLoadingFallback footer={<CloudConnectionNotice />} />
									) : (
										<Suspense fallback={<SurfaceFallback />}>
											<ChatLanding
												key={`${activeEnvironmentId}:${selectedFolderId}:${landingRevision}`}
											/>
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
									hidden={activeMainTab !== "plugins"}
									className="flex min-h-0 flex-1 flex-col"
								>
									{activeMainTab === "plugins" && (
										<Suspense fallback={<SurfaceFallback />}>
											<PluginsPage />
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
												<DirectoryUnavailableSurface
													label={uiMessage(
														"shell:app_files_are_unavailable_because_this_directory_was_deleted",
													)}
												/>
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
												<DirectoryUnavailableSurface
													label={uiMessage(
														"shell:app_changes_are_unavailable_because_this_directory_was_deleted",
													)}
												/>
											) : (
												<ChangesReview />
											)}
										</Suspense>
									</div>
								) : null}
							</div>
						</main>
						{!fullWidthPage &&
						selectedChatRef !== null &&
						activeContext.status === "ready" ? (
							<Suspense fallback={null}>
								<BottomTerminalDock
									chatRef={selectedChatRef}
									rootPath={activeContext.rootPath}
									directoryUnavailable={directoryUnavailable}
								/>
							</Suspense>
						) : null}
					</div>
				</Panel>
				<Separator className="workspace-separator" disabled={fullWidthPage} />
				<Panel
					id="files"
					defaultSize="22%"
					minSize={compactWorkspace ? "280px" : "360px"}
					maxSize="55%"
					collapsible
					collapsedSize="0%"
					panelRef={rightPanelRef}
					elementRef={rightPanelElementRef}
					onResize={(size, _id, prev) => {
						if (prev === undefined || fullWidthPage) return;
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
					<div
						className="workspace-column workspace-right-column"
						hidden={fullWidthPage}
						inert={fullWidthPage}
					>
						<div className="workspace-surface flex min-h-0 flex-1 flex-col">
							<div className="flex min-h-0 flex-1 flex-col">
								{shouldMountRightPane(rightSidebarOpen && !fullWidthPage) ? (
									<Suspense fallback={<SurfaceFallback />}>
										<RightPane
											directoryUnavailable={directoryUnavailable}
											visible={rightSidebarOpen && !fullWidthPage}
										/>
									</Suspense>
								) : null}
							</div>
						</div>
					</div>
				</Panel>
			</Group>
			<Suspense fallback={null}>
				<SidebarPeekTrigger />
				<SidebarPeekOverlay />
				<FileSearch />
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
