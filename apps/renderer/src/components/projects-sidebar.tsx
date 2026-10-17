import { chatRecency } from "@zuse/client-runtime/chat-recency";
import { useThreadListSidebarEnabled } from "../lib/browser-device-preferences.ts";
import {
	isCloudProjectFolder,
	mergeCloudProjectFolders,
} from "../lib/cloud-project-folders.ts";
import {
	refreshHostedProjects,
	selectHostedCloudHome,
} from "../lib/hosted-workspace.ts";
import { isInputComposing } from "../lib/input-composition.ts";
import { openProjectSetupDialog } from "../lib/project-setup-dialog-state.ts";
import {
	rendererWorkspaceSnapshot,
	subscribeRendererWorkspace,
} from "../lib/renderer-workspace.ts";
import { buildThreadList, type ThreadListEntry } from "../lib/thread-list.ts";
import { useChatAttention } from "../lib/use-chat-attention.ts";
import { useCloudProjects } from "../lib/use-cloud-projects.ts";
import { GithubStarPrompt } from "./github-star-prompt.tsx";
import { HostedLaptopSection } from "./hosted-sidebar.tsx";
import { WorkspaceSwitcher } from "./workspace-switcher.tsx";
import "@zuse/i18n/english/projects";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { DitherAvatar } from "@repo/ui/dither";
import {
	type Chat,
	type ChatId,
	type CloudChatSummary,
	EnvironmentId,
	type Folder,
	FolderId,
	type GitOriginInfo,
	type GitPrInfo,
	type ProviderId,
	type SessionId,
	type SessionStatus,
	type ThreadGoal,
} from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	Analytics01Icon,
	ArchiveArrowDownIcon,
	ArchiveArrowUpIcon,
	ArchiveIcon,
	DashboardSpeedIcon,
	Delete02Icon,
	Edit01Icon,
	Folder01Icon,
	FolderAddIcon,
	GitBranchIcon,
	HelpCircleIcon,
	Layers01Icon,
	Login03Icon,
	PencilIcon,
	PuzzleIcon,
	Robot01Icon,
	ServerStack01Icon,
	Settings01Icon,
	SquareLock01Icon,
	TaskDone01Icon,
	UserCircleIcon,
} from "@zuse/icons/solid-rounded";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
	lazy,
	type ReactNode,
	Suspense,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { TypewriterText } from "~/components/typewriter-text.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { CompactEmptyState } from "~/components/ui/compact-empty-state";
import { Menu, MenuItem, MenuPopup, MenuSeparator } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useAuth } from "~/hooks/use-auth.ts";
import {
	type ChatAttentionState,
	chatAttentionLabel,
	deriveChatAttentionState,
	derivePermissionAttention,
	executionAttentionLabel,
	executionAttentionState,
	mergeChatAttentionStates,
} from "~/lib/chat-attention-state";
import { chatCreationIsInProgress } from "~/lib/chat-creation-lifecycle.ts";
import { displayPath } from "~/lib/display-path";
import { activeSessionById } from "~/lib/environment-entities.ts";
import { useEnvironmentEntities } from "~/lib/environment-entity-hooks.ts";
import { useEnvironmentPermissions } from "~/lib/environment-permissions-client-bus.ts";
import { useEnvironmentQuestionAttachments } from "~/lib/environment-question-attachments-client-bus.ts";
import { formatError } from "~/lib/format-error.ts";
import { isHostedProduct } from "~/lib/hosted-session.ts";
import { filterActionableQuestionInteractions } from "~/lib/question-actionability.ts";
import { cn, formatCompactNumber } from "~/lib/utils";
import {
	type ChatPullRequest,
	chatPullRequests,
} from "../lib/chat-pull-requests.ts";
import {
	cloudChatShowsLoading,
	cloudChatShowsWorking,
	deriveCloudChatActivity,
} from "../lib/cloud-chat-activity.ts";
import { startCloudCheckout } from "../lib/cloud-checkout.ts";
import { cloudWorkspaceBetaAvailable } from "../lib/cloud-machines-availability.ts";
import {
	cloudSummaryActiveSessionId,
	useCloudChatCatalogStore,
} from "../lib/cloud-workspace-catalog.ts";
import {
	hasCloudEntitlement,
	loadCloudEntitlements,
} from "../lib/cloud-workspace-session-cache.ts";
import {
	openCloudChat,
	repositoryIdentityForOrigin,
	useCloudChatsStore,
	watchCloudChatCatalog,
} from "../lib/cloud-workspaces.ts";
import { dispatchCommand } from "../lib/commands.ts";
import { noteSessionRuntimeCompletion } from "../lib/completion-sounds.ts";
import { formatElapsed } from "../lib/delegation-display.ts";
import {
	useEnvironmentShellCatalog,
	useEnvironmentShellResource,
} from "../lib/environment-shell-client-bus.ts";
import {
	type GitDiffStat,
	useGitWorkspaceResource,
} from "../lib/git-workspace-client-bus.ts";
import { openNewChatLanding } from "../lib/open-new-chat-landing.ts";
import { openPluginsPage } from "../lib/plugins-navigation.ts";
import {
	activeAgentCountLabel,
	getPowerRuntimeActivity,
	subscribePowerRuntimeActivity,
} from "../lib/power-runtime-activity.ts";
import {
	branchStateFor,
	diffStatsFor,
	prStateLabelFor,
} from "../lib/pr-branch-state.ts";
import {
	buildLogicalProjectGroups,
	type LogicalChatRef,
	type LogicalProjectGroup,
	preferredGroupMember,
} from "../lib/project-groups.ts";
import {
	environmentBelongsToWorkspace,
	getLocalEnvironmentId,
} from "../lib/rpc-client.ts";
import { useSessionGoalResource } from "../lib/session-goal-client-bus.ts";
import {
	GOAL_STATUS_MESSAGE,
	isGoalInProgress,
} from "../lib/session-goal-presentation.ts";
import { isSessionRuntimeBusy } from "../lib/session-runtime-state.ts";
import {
	useOptionalRendererSessionTimeline,
	useRendererSessionTimelines,
} from "../lib/session-timeline-hooks.ts";
import { formatShortcut } from "../lib/shortcuts.ts";
import {
	PROJECT_ICON_COLOR_IDS,
	PROJECT_ICON_COLOR_STYLES,
	type ProjectIconColorId,
} from "../lib/sidebar-project-icon.ts";
import { switchToEnvironment } from "../lib/switch-environment.ts";
import {
	type SidebarDropLine,
	useSidebarOrganize,
} from "../lib/use-sidebar-organize.ts";
import { useArchivePreviewStore } from "../store/archive-preview.ts";
import {
	archiveChatWithConfirm,
	chatArchiveProgressLabel,
	isChatUnread,
	useChatsStore,
} from "../store/chats.ts";
import {
	type EnvironmentCatalogEntry,
	environmentCatalogViewState,
	useEnvironmentCatalogStore,
} from "../store/environment-catalog.ts";
import {
	gitStackKey,
	readGitStack,
	useGitStackStore,
} from "../store/git-stack.ts";
import { useRegisterPane } from "../store/pane-focus.ts";
import { subscribeSessionTerminals } from "../store/session-runtime.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { EMPTY_WORKTREES, useWorktreesStore } from "../store/worktrees.ts";
import { openAddComputerDialog } from "./add-computer-dialog.tsx";
import { BranchIcon, type BranchState, PrStateIcon } from "./branch-icon.tsx";
import { ChatPullRequestList } from "./chat-pull-request-list.tsx";
import { DitherCloudIcon } from "./dither-cloud-icon.tsx";
import { SlackIcon } from "./icons/slack-icon.tsx";
import { ProjectAddMenu } from "./project-add-menu.tsx";
import { ProviderIcon } from "./provider-icons.tsx";
import { AgentActivityOrb } from "./ui/agent-activity-orb.tsx";
import { DitherActionButton } from "./ui/dither-action-button.tsx";
import { Spinner } from "./ui/spinner";

const CLOUD_WORKSPACE_BETA_AVAILABLE = cloudWorkspaceBetaAvailable();
const EMPTY_CLOUD_CHATS: ReadonlyArray<CloudChatSummary> = [];

const loadRenameDialog = () => import("./rename-dialog.tsx");
const RenameDialog = lazy(() =>
	loadRenameDialog().then((module) => ({ default: module.RenameDialog })),
);
const ComputerSwitcher = lazy(() =>
	import("./computer-switcher.tsx").then((module) => ({
		default: module.ComputerSwitcher,
	})),
);
const UsageLimitsMenu = lazy(() =>
	import("./usage/usage-limits-submenu.tsx").then((module) => ({
		default: module.UsageLimitsMenu,
	})),
);

const sidebarErrorToastCache = {
	chats: null as string | null,
	sessions: null as string | null,
	workspace: null as string | null,
};

const initialsOf = (name: string): string => {
	const parts = name.split(/[-_.\s]+/).filter(Boolean);
	const letters =
		parts.length >= 2
			? `${parts[0]?.charAt(0) ?? ""}${parts[1]?.charAt(0) ?? ""}`
			: name.slice(0, 2);
	return letters.toUpperCase();
};

function showSidebarErrorToast(
	source: keyof typeof sidebarErrorToastCache,
	title: string,
	message: string | null,
): void {
	if (message === null) {
		sidebarErrorToastCache[source] = null;
		return;
	}
	if (sidebarErrorToastCache[source] === message) return;
	sidebarErrorToastCache[source] = message;
	toastManager.add({
		type: "error",
		title,
		description: message,
	});
}

function SidebarErrorToasts(): null {
	const workspaceError = useWorkspaceStore((s) => s.error);
	const chatsError = useChatsStore((s) => s.error);
	const sessionsError = useSessionsStore((s) => s.error);

	useEffect(() => {
		showSidebarErrorToast("workspace", "Project error", workspaceError);
	}, [workspaceError]);

	useEffect(() => {
		showSidebarErrorToast("chats", "Chats error", chatsError);
	}, [chatsError]);

	useEffect(() => {
		showSidebarErrorToast("sessions", "Sessions error", sessionsError);
	}, [sessionsError]);

	return null;
}

const githubOwnerAvatarUrl = (host: string, owner: string): string | null =>
	host.toLowerCase() === "github.com"
		? `https://github.com/${encodeURIComponent(owner)}.png?size=80`
		: null;

const avatarUrlFor = (origin: GitOriginInfo | null): string | null =>
	origin === null ? null : githubOwnerAvatarUrl(origin.host, origin.owner);

const avatarUrlForRepositoryIdentity = (identity: string): string | null => {
	const [host, owner] = identity.split("/");
	return host === undefined || owner === undefined
		? null
		: githubOwnerAvatarUrl(host, owner);
};

const formatRelative = (iso: Date, compact = false): string => {
	const ms = Date.now() - iso.getTime();
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return compact ? "now" : "just now";
	const suffix = compact ? "" : " ago";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m${suffix}`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h${suffix}`;
	const day = Math.floor(hr / 24);
	return `${day}d${suffix}`;
};

const environmentProjectKey = (
	environmentId: string,
	projectId: FolderId,
): string => `${environmentId}\u0001${projectId}`;

function useSessionRuntimeEffects(): void {
	useEffect(
		() =>
			subscribeSessionTerminals((sessionId) => {
				noteSessionRuntimeCompletion();
				const session = activeSessionById(sessionId);
				if (session === null) return;
				const chats = useChatsStore.getState();
				if (chats.selectedChatId === session.chatId) {
					void chats.markRead(session.chatId);
				} else {
					chats.noteChatActivity(session.chatId);
				}
			}),
		[],
	);
}

export function ProjectsSidebar() {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	useSessionRuntimeEffects();
	const paneRef = useRef<HTMLElement>(null);
	useRegisterPane("sidebar", paneRef);
	const workspaceScope = useSyncExternalStore(
		subscribeRendererWorkspace,
		rendererWorkspaceSnapshot,
	);
	const storedFolders = useWorkspaceStore((s) => s.folders);
	const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
	const loading = useWorkspaceStore((s) => s.loading);
	const removeFolder = useWorkspaceStore((s) => s.remove);
	const remove = async (id: FolderId) => {
		if (isCloudProjectFolder(id)) {
			useUiStore
				.getState()
				.setSettingsSection({ kind: "cloud", page: "repositories" });
			useUiStore.getState().setView("settings");
		} else if (isHostedProduct()) openProjectSetupDialog();
		else await removeFolder(id);
	};
	const selectFolder = useWorkspaceStore((s) => s.select);
	const select = async (id: FolderId) => {
		if (isHostedProduct()) selectHostedCloudHome(id);
		else await selectFolder(id);
	};
	const storedCatalogEntries = useEnvironmentCatalogStore((s) => s.entries);
	const catalogEntries = useMemo(
		() =>
			storedCatalogEntries.filter((entry) =>
				environmentBelongsToWorkspace(
					entry.environmentId,
					workspaceScope.scope,
				),
			),
		[storedCatalogEntries, workspaceScope],
	);
	const activeEnvironmentId = useEnvironmentCatalogStore(
		(s) => s.activeEnvironmentId,
	);
	const workspaceFolders = useMemo(
		() =>
			environmentBelongsToWorkspace(activeEnvironmentId, workspaceScope.scope)
				? storedFolders
				: [],
		[activeEnvironmentId, workspaceScope, storedFolders],
	);
	const shellViews = useEnvironmentShellCatalog(
		catalogEntries.map((entry) => entry.environmentId),
	);
	const initializeEnvironmentCatalog = useEnvironmentCatalogStore(
		(s) => s.initialize,
	);
	const catalogInitialized = useEnvironmentCatalogStore((s) => s.initialized);
	const catalogInitializing = useEnvironmentCatalogStore((s) => s.initializing);
	const catalogInitializationError = useEnvironmentCatalogStore(
		(s) => s.initializationError,
	);

	const {
		chatsByProject,
		originsByFolder: runtimeOrigins,
		sessionsByProject,
		folders: cloudFolders,
	} = useEnvironmentEntities(
		isHostedProduct() ? "local" : activeEnvironmentId,
		isHostedProduct() ||
			environmentBelongsToWorkspace(activeEnvironmentId, workspaceScope.scope),
	);
	const cloudProjects = useCloudProjects();
	const { folders, originsByFolder: origins } = useMemo(
		() =>
			mergeCloudProjectFolders(
				isHostedProduct() ? cloudFolders : workspaceFolders,
				runtimeOrigins,
				cloudProjects,
			),
		[cloudFolders, workspaceFolders, runtimeOrigins, cloudProjects],
	);
	useEffect(() => {
		if (isHostedProduct())
			void refreshHostedProjects().catch((cause) =>
				toastManager.add({ type: "error", title: formatError(cause) }),
			);
	}, [workspaceScope]);
	const storedCloudChats = useCloudChatCatalogStore((s) => s.summaries);
	const cloudChats = CLOUD_WORKSPACE_BETA_AVAILABLE
		? storedCloudChats
		: EMPTY_CLOUD_CHATS;
	const cloudAccount = useAuth().user?.id;

	const [expanded, setExpanded] = useState<Record<string, boolean>>({});

	useEffect(() => {
		if (CLOUD_WORKSPACE_BETA_AVAILABLE && cloudAccount)
			return watchCloudChatCatalog();
	}, [cloudAccount, workspaceScope]);

	const desktopCatalogEnabled = window.zuse?.ssh !== undefined;

	useEffect(() => {
		void initializeEnvironmentCatalog().catch((cause) =>
			console.error("[zuse] environment catalog initialize failed", cause),
		);
	}, [initializeEnvironmentCatalog]);

	useEffect(() => {
		if (selectedFolderId === null) return;
		const key = environmentProjectKey(activeEnvironmentId, selectedFolderId);
		setExpanded((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
	}, [activeEnvironmentId, selectedFolderId]);

	const onToggleKey = (key: string) => {
		setExpanded((previous) => ({ ...previous, [key]: !previous[key] }));
	};
	const onToggleExpanded = (environmentId: string, id: FolderId) => {
		onToggleKey(environmentProjectKey(environmentId, id));
	};

	const showComputerControls =
		desktopCatalogEnabled &&
		catalogEntries.filter((entry) => entry.status === "connected").length > 1;

	const logicalGroups = useMemo(
		() =>
			desktopCatalogEnabled
				? buildLogicalProjectGroups({
						entries: catalogEntries,
						activeEnvironmentId,
						localEnvironmentId: getLocalEnvironmentId(),
						activeFolders: folders,
						activeOrigins: origins,
						activeChatsByProject: chatsByProject,
						shellsByEnvironment: Object.fromEntries(
							Object.entries(shellViews).map(([environmentId, view]) => [
								environmentId,
								view.data,
							]),
						),
					})
				: [],
		[
			desktopCatalogEnabled,
			catalogEntries,
			activeEnvironmentId,
			folders,
			origins,
			chatsByProject,
			shellViews,
			uiMessage,
		],
	);
	const scratchGroups = useMemo(
		() =>
			buildLogicalProjectGroups({
				entries: catalogEntries,
				activeEnvironmentId,
				localEnvironmentId: getLocalEnvironmentId(),
				activeFolders: folders,
				folderKind: "scratch",
				activeOrigins: origins,
				activeChatsByProject: chatsByProject,
				shellsByEnvironment: Object.fromEntries(
					Object.entries(shellViews).map(([id, view]) => [id, view.data]),
				),
			}),
		[
			catalogEntries,
			activeEnvironmentId,
			folders,
			origins,
			chatsByProject,
			shellViews,
		],
	);

	const projectKeys = useMemo(
		() =>
			desktopCatalogEnabled
				? logicalGroups.map((group) => group.key)
				: folders
						.filter((folder) => folder.kind !== "scratch")
						.map((folder) => folder.id),
		[desktopCatalogEnabled, folders, logicalGroups, uiMessage],
	);
	const ungroupedCloudChats = useMemo(() => {
		const representedChats = new Set([
			...Object.values(chatsByProject)
				.flat()
				.filter((chat) => chat.archivedAt === null)
				.map((chat) => chat.id),
			...logicalGroups.flatMap((group) =>
				group.chats.map((row) => row.chat.id),
			),
		]);
		const repositories = new Set([
			...Object.values(origins).map(repositoryIdentityForOrigin),
			...logicalGroups.map((group) =>
				repositoryIdentityForOrigin(group.origin),
			),
		]);
		return cloudChats.filter(
			(chat) =>
				chat.archivedAt === undefined &&
				chat.state !== "archived" &&
				chat.state !== "deleted" &&
				!representedChats.has(chat.chatId) &&
				!repositories.has(chat.repositoryIdentity),
		);
	}, [cloudChats, logicalGroups, origins, chatsByProject]);
	const organize = useSidebarOrganize(projectKeys);
	const threadListSidebar = useThreadListSidebarEnabled();
	const hiddenArchivedChatIds = useChatsStore(
		(state) => state.hiddenArchivedChatIds,
	);

	const threadListEntries = useMemo(
		() =>
			threadListSidebar
				? buildThreadList({
						chatsByProject,
						folders,
						remoteChats: desktopCatalogEnabled
							? [...logicalGroups, ...scratchGroups].flatMap((group) =>
									remoteChatRows(group).map((row) => ({
										...row,
										repositoryName: group.displayName,
									})),
								)
							: [],
						cloudChats,
						hiddenChatIds: hiddenArchivedChatIds,
					})
				: [],
		[
			threadListSidebar,
			chatsByProject,
			folders,
			desktopCatalogEnabled,
			logicalGroups,
			cloudChats,
			hiddenArchivedChatIds,
			scratchGroups,
		],
	);
	const scratchEntries = useMemo(
		() =>
			buildThreadList({
				folders: folders
					.filter((folder) => folder.kind === "scratch")
					.map((folder) => ({
						...folder,
						name: uiMessage("projects:no_project"),
					})),
				chatsByProject,
				remoteChats: scratchGroups.flatMap((group) =>
					remoteChatRows(group).map((row) => ({
						...row,
						repositoryName: uiMessage("projects:no_project"),
					})),
				),
				cloudChats: [],
				hiddenChatIds: hiddenArchivedChatIds,
			}),
		[folders, chatsByProject, scratchGroups, hiddenArchivedChatIds],
	);

	const catalogViewState = environmentCatalogViewState({
		initialized: catalogInitialized,
		initializing: catalogInitializing,
		initializationError: catalogInitializationError,
		projectCount: logicalGroups.length + ungroupedCloudChats.length,
		projectsLoading: loading,
	});

	return (
		<aside
			ref={paneRef}
			aria-label={uiMessage("common:projects_and_chats")}
			data-pane="sidebar"
			tabIndex={-1}
			className="flex h-full min-h-0 w-full flex-col text-sidebar-foreground outline-none"
		>
			<WorkspaceSwitcher />
			{desktopCatalogEnabled || isHostedProduct() ? null : (
				<Suspense fallback={<div className="h-[60px]" />}>
					<ComputerSwitcher />
				</Suspense>
			)}
			<SidebarActions />
			{showComputerControls ? (
				<div className="flex items-center justify-between px-2.5 py-1.5 text-[12px] text-muted-foreground">
					<span>{uiMessage("projects:projects_sidebar_computers")}</span>
					<Suspense fallback={<span className="size-8" />}>
						<ComputerSwitcher />
					</Suspense>
				</div>
			) : null}
			<div className="flex items-center justify-between px-2.5 py-1.5 text-[12px] text-muted-foreground">
				<span>
					{uiMessage(
						threadListSidebar
							? "projects:projects_sidebar_threads"
							: "projects:projects_sidebar_projects",
					)}
				</span>
				<div className="flex items-center">
					{threadListSidebar ? null : (
						<NewProjectGroupButton
							onCreate={() =>
								organize.setGroupDialog({ kind: "create", projectKeys: [] })
							}
						/>
					)}
					<ProjectAddMenu />
				</div>
			</div>
			{showComputerControls ? (
				<CatalogConnectionNotice entries={catalogEntries} />
			) : null}
			<SidebarErrorToasts />

			<ul
				data-sidebar-scroll
				className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-1.5"
			>
				{threadListSidebar ? (
					<ThreadListSection
						entries={threadListEntries}
						origins={origins}
						loading={loading}
					/>
				) : (
					<>
						{scratchEntries.length > 0 ? (
							<>
								<li className="px-2 pb-1 pt-2 text-[12px] text-muted-foreground">
									{uiMessage("projects:no_project")}
								</li>
								<ThreadListSection
									entries={scratchEntries}
									origins={{}}
									loading={loading}
								/>
							</>
						) : null}
						{ungroupedCloudChats.map((summary) => (
							<CloudChatRow key={summary.workspaceId} summary={summary} />
						))}
						{desktopCatalogEnabled ? (
							<>
								{catalogViewState === "loading" ? (
									<li
										className="flex items-center justify-center gap-2 px-3 py-4 text-[13px] text-muted-foreground"
										aria-busy="true"
									>
										<Spinner className="size-3.5" />
										{uiMessage("projects:projects_sidebar_loading_projects")}
									</li>
								) : null}
								{catalogViewState === "unavailable" ? (
									<li className="px-3 py-4 text-center text-[13px] text-muted-foreground">
										<p role="alert">
											{uiMessage(
												"projects:projects_sidebar_this_computer_couldn_t_load_its_projects",
											)}
										</p>
										<p className="mt-1 text-[12px]">
											{catalogInitializationError}
										</p>
										<button
											type="button"
											className="mt-2 rounded-md border border-sidebar-border px-2.5 py-1 text-[12px] text-sidebar-foreground hover:bg-sidebar-accent"
											onClick={() => {
												void initializeEnvironmentCatalog().catch(
													() => undefined,
												);
											}}
										>
											{uiMessage("common:retry")}
										</button>
									</li>
								) : null}
								{catalogViewState === "empty" ? (
									<li>
										<CompactEmptyState
											title={uiMessage(
												"projects:projects_sidebar_no_projects_yet",
											)}
											description={uiMessage(
												"projects:projects_sidebar_use_to_add_a_repository",
											)}
										/>
									</li>
								) : null}
								{organize.nodes.map((node) =>
									node.kind === "group" ? (
										<UserProjectGroup
											key={organize.sidebarGroupItemKey(node.group.id)}
											group={node.group}
											dropLine={organize.dropLineFor(
												organize.sidebarGroupItemKey(node.group.id),
											)}
											dragProps={organize.groupDragProps(node.group.id)}
											emptyDropActive={organize.isEmptyGroupDropActive(
												node.group.id,
											)}
											emptyDropProps={organize.emptyGroupDropProps(
												node.group.id,
											)}
											onToggleCollapsed={() =>
												organize.setGroupCollapsed(
													node.group.id,
													!node.group.collapsed,
												)
											}
											onRename={() =>
												organize.setGroupDialog({
													kind: "rename",
													groupId: node.group.id,
													name: node.group.name,
												})
											}
											onDissolve={() => organize.dissolveGroup(node.group.id)}
											onSetIconColor={(color) =>
												organize.setGroupIconColor(node.group.id, color)
											}
										>
											{node.group.projectKeys.map((key) => {
												const logical = logicalGroups.find(
													(group) => group.key === key,
												);
												if (logical === undefined) return null;
												return (
													<SidebarLogicalRow
														key={key}
														group={logical}
														folders={folders}
														origins={origins}
														chatsByProject={chatsByProject}
														sessionsByProject={sessionsByProject}
														cloudChats={cloudChats}
														activeEnvironmentId={activeEnvironmentId}
														expanded={expanded}
														nested
														dropLine={organize.dropLineFor(key)}
														dragProps={organize.projectDragProps(
															key,
															node.group.id,
														)}
														onToggleExpanded={onToggleExpanded}
														onToggleKey={onToggleKey}
														onSelect={select}
														onRemove={remove}
														organize={organize}
													/>
												);
											})}
										</UserProjectGroup>
									) : (
										(() => {
											const logical = logicalGroups.find(
												(group) => group.key === node.key,
											);
											if (logical === undefined) return null;
											return (
												<SidebarLogicalRow
													key={node.key}
													group={logical}
													folders={folders}
													origins={origins}
													chatsByProject={chatsByProject}
													sessionsByProject={sessionsByProject}
													cloudChats={cloudChats}
													activeEnvironmentId={activeEnvironmentId}
													expanded={expanded}
													dropLine={organize.dropLineFor(node.key)}
													dragProps={organize.projectDragProps(node.key, null)}
													onToggleExpanded={onToggleExpanded}
													onToggleKey={onToggleKey}
													onSelect={select}
													onRemove={remove}
													organize={organize}
												/>
											);
										})()
									),
								)}
							</>
						) : (
							<>
								{folders.every((folder) => folder.kind === "scratch") &&
								ungroupedCloudChats.length === 0 &&
								!loading ? (
									<li>
										<CompactEmptyState
											title={uiMessage(
												"projects:projects_sidebar_no_projects_yet",
											)}
											description={uiMessage(
												"projects:projects_sidebar_use_to_add_a_repository",
											)}
										/>
									</li>
								) : null}
								{organize.nodes.map((node) =>
									node.kind === "group" ? (
										<UserProjectGroup
											key={organize.sidebarGroupItemKey(node.group.id)}
											group={node.group}
											dropLine={organize.dropLineFor(
												organize.sidebarGroupItemKey(node.group.id),
											)}
											dragProps={organize.groupDragProps(node.group.id)}
											emptyDropActive={organize.isEmptyGroupDropActive(
												node.group.id,
											)}
											emptyDropProps={organize.emptyGroupDropProps(
												node.group.id,
											)}
											onToggleCollapsed={() =>
												organize.setGroupCollapsed(
													node.group.id,
													!node.group.collapsed,
												)
											}
											onRename={() =>
												organize.setGroupDialog({
													kind: "rename",
													groupId: node.group.id,
													name: node.group.name,
												})
											}
											onDissolve={() => organize.dissolveGroup(node.group.id)}
											onSetIconColor={(color) =>
												organize.setGroupIconColor(node.group.id, color)
											}
										>
											{node.group.projectKeys.map((key) => {
												const folder = folders.find(
													(entry) => entry.id === key,
												);
												if (folder === undefined) return null;
												return (
													<SidebarFolderRow
														key={folder.id}
														folder={folder}
														origins={origins}
														chatsByProject={chatsByProject}
														sessionsByProject={sessionsByProject}
														cloudChats={cloudChats}
														activeEnvironmentId={activeEnvironmentId}
														expanded={expanded}
														nested
														dropLine={organize.dropLineFor(folder.id)}
														dragProps={organize.projectDragProps(
															folder.id,
															node.group.id,
														)}
														onToggleExpanded={onToggleExpanded}
														onSelect={select}
														onRemove={remove}
														organize={organize}
													/>
												);
											})}
										</UserProjectGroup>
									) : (
										(() => {
											const folder = folders.find(
												(entry) => entry.id === node.key,
											);
											if (folder === undefined) return null;
											return (
												<SidebarFolderRow
													key={folder.id}
													folder={folder}
													origins={origins}
													chatsByProject={chatsByProject}
													sessionsByProject={sessionsByProject}
													cloudChats={cloudChats}
													activeEnvironmentId={activeEnvironmentId}
													expanded={expanded}
													dropLine={organize.dropLineFor(folder.id)}
													dragProps={organize.projectDragProps(folder.id, null)}
													onToggleExpanded={onToggleExpanded}
													onSelect={select}
													onRemove={remove}
													organize={organize}
												/>
											);
										})()
									),
								)}
							</>
						)}
					</>
				)}
			</ul>
			{isHostedProduct() && workspaceScope.scope.kind === "personal" && (
				<HostedLaptopSection />
			)}
			<GithubStarPrompt />
			<SidebarFooter />
			{organize.groupDialog !== null ? (
				<Suspense fallback={null}>
					<RenameDialog
						open
						title={
							organize.groupDialog.kind === "create"
								? uiMessage("projects:projects_sidebar_new_project_group")
								: uiMessage("projects:projects_sidebar_rename_group")
						}
						description={
							organize.groupDialog.kind === "create"
								? uiMessage(
										"projects:projects_sidebar_name_a_group_to_collect_projects_in_the_sidebar",
									)
								: uiMessage(
										"projects:projects_sidebar_this_name_is_only_shown_in_the_sidebar",
									)
						}
						label={uiMessage("projects:projects_sidebar_group_name")}
						value={
							organize.groupDialog.kind === "rename"
								? organize.groupDialog.name
								: "New group"
						}
						onOpenChange={(open) => {
							if (!open) organize.setGroupDialog(null);
						}}
						onRename={async (name) => {
							const dialog = organize.groupDialog;
							if (dialog === null) return;
							if (dialog.kind === "create") {
								organize.createGroup(name, dialog.projectKeys);
							} else {
								organize.renameGroup(dialog.groupId, name);
							}
							organize.setGroupDialog(null);
						}}
					/>
				</Suspense>
			) : null}
		</aside>
	);
}

const THREAD_LIST_INITIAL_ROWS = 100;

function ThreadListSection({
	entries,
	origins,
	loading,
}: {
	entries: ReadonlyArray<ThreadListEntry>;
	origins: Readonly<Record<string, GitOriginInfo | null>>;
	loading: boolean;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);
	const [showAll, setShowAll] = useState(false);

	const projectByRepository = useMemo(
		() =>
			new Map(
				Object.entries(origins).map(([folderId, origin]) => [
					repositoryIdentityForOrigin(origin),
					{ id: FolderId.make(folderId), name: origin?.repo },
				]),
			),
		[origins],
	);

	if (entries.length === 0) {
		if (loading) return null;
		return (
			<li>
				<CompactEmptyState
					title={uiMessage("projects:projects_sidebar_no_threads_yet")}
					description={uiMessage(
						"projects:projects_sidebar_start_a_chat_to_see_it_here",
					)}
				/>
			</li>
		);
	}
	const visible = showAll
		? entries
		: entries.slice(0, THREAD_LIST_INITIAL_ROWS);
	return (
		<>
			{visible.map((entry) =>
				entry.kind === "local" ? (
					<ChatRow
						key={entry.id}
						chat={entry.chat}
						projectRoot={entry.projectRoot}
						projectName={
							origins[entry.chat.projectId]?.repo ?? entry.projectName
						}
						projectAvatarUrl={avatarUrlFor(
							origins[entry.chat.projectId] ?? null,
						)}
						variant="threadList"
					/>
				) : entry.kind === "remote" ? (
					<CatalogChatRow
						key={entry.id}
						chatRef={entry.remote.ref}
						connected={entry.remote.connected}
						repositoryName={entry.remote.repositoryName}
						variant="threadList"
					/>
				) : (
					<CloudChatRow
						key={entry.id}
						summary={entry.summary}
						projectId={
							projectByRepository.get(entry.summary.repositoryIdentity)?.id
						}
						projectName={
							projectByRepository.get(entry.summary.repositoryIdentity)?.name
						}
						variant="threadList"
					/>
				),
			)}
			{visible.length < entries.length ? (
				<li>
					<button
						type="button"
						onClick={() => setShowAll(true)}
						className="flex h-7 w-full items-center rounded-md px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-sidebar-accent/40 hover:text-sidebar-foreground"
					>
						{uiMessage("projects:projects_sidebar_show_all_threads", {
							count: String(entries.length),
						})}
					</button>
				</li>
			) : null}
		</>
	);
}

function NewProjectGroupButton({ onCreate }: { onCreate: () => void }) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						className="rounded p-1 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
						aria-label={uiMessage(
							"projects:projects_sidebar_new_project_group",
						)}
						onClick={onCreate}
					>
						<HugeiconsIcon icon={FolderAddIcon} className="size-3.5" />
					</button>
				}
			/>
			<TooltipPopup>
				{uiMessage("projects:projects_sidebar_new_group")}
			</TooltipPopup>
		</Tooltip>
	);
}

type Organize = ReturnType<typeof useSidebarOrganize>;

function IconColorPicker({
	value,
	onChange,
}: {
	value?: ProjectIconColorId;
	onChange: (color: ProjectIconColorId | null) => void;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	return (
		<div className="px-2 py-1.5">
			<div className="mb-1.5 text-[11px] text-muted-foreground">
				{uiMessage("projects:projects_sidebar_icon_color")}
			</div>
			<div className="flex flex-wrap gap-1.5">
				<button
					type="button"
					aria-label={uiMessage("projects:projects_sidebar_default_icon_color")}
					aria-pressed={value === undefined}
					onClick={() => onChange(null)}
					className={cn(
						"size-4 rounded-full border border-border bg-muted",
						value === undefined && "ring-2 ring-foreground/70",
					)}
				/>
				{PROJECT_ICON_COLOR_IDS.map((id) => (
					<button
						key={id}
						type="button"
						aria-label={uiMessage("projects:projects_sidebar_icon_color_2", {
							id: String(id),
						})}
						aria-pressed={value === id}
						onClick={() => onChange(id)}
						className={cn(
							"size-4 rounded-full",
							PROJECT_ICON_COLOR_STYLES[id].swatch,
							value === id && "ring-2 ring-foreground/70",
						)}
					/>
				))}
			</div>
		</div>
	);
}

function DropLine({ line }: { line: SidebarDropLine | null }) {
	if (line === null) return null;
	if (line === "into") {
		return (
			<span className="pointer-events-none absolute inset-0 rounded-md ring-1 ring-foreground/40" />
		);
	}
	return (
		<span
			className={cn(
				"pointer-events-none absolute inset-x-2 h-0.5 rounded bg-foreground/80",
				line === "before" ? "-top-0.5" : "-bottom-0.5",
			)}
		/>
	);
}

function UserProjectGroup({
	group,
	dropLine,
	dragProps,
	emptyDropActive,
	emptyDropProps,
	onToggleCollapsed,
	onRename,
	onDissolve,
	onSetIconColor,
	children,
}: {
	group: Organize["groups"][number];
	dropLine: SidebarDropLine | null;
	dragProps: ReturnType<Organize["groupDragProps"]>;
	emptyDropActive: boolean;
	emptyDropProps: ReturnType<Organize["emptyGroupDropProps"]>;
	onToggleCollapsed: () => void;
	onRename: () => void;
	onDissolve: () => void;
	onSetIconColor: (color: ProjectIconColorId | null) => void;
	children: ReactNode;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	const [menuOpen, setMenuOpen] = useState(false);
	const anchorRef = useRef<{ getBoundingClientRect: () => DOMRect } | null>(
		null,
	);
	const Chevron = group.collapsed ? ChevronRight : ChevronDown;
	return (
		<li>
			{/* biome-ignore lint/a11y/useSemanticElements: nested menu + drag handle. */}
			<div
				role="button"
				tabIndex={0}
				{...dragProps}
				onClick={() => {
					onToggleCollapsed();
				}}
				onKeyDown={(event) => {
					if (isInputComposing(event)) return;

					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onToggleCollapsed();
					}
				}}
				onContextMenu={(event) => {
					event.preventDefault();
					event.stopPropagation();
					const rect = new DOMRect(event.clientX, event.clientY, 0, 0);
					anchorRef.current = { getBoundingClientRect: () => rect };
					setMenuOpen(true);
				}}
				className="group relative flex cursor-pointer select-none items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] transition-colors hover:bg-sidebar-accent/30"
			>
				<DropLine line={dropLine} />
				<HugeiconsIcon
					icon={Folder01Icon}
					className={cn(
						"size-3.5 shrink-0",
						group.iconColor === undefined
							? "text-muted-foreground"
							: PROJECT_ICON_COLOR_STYLES[group.iconColor].icon,
					)}
				/>
				<span className="min-w-0 flex-1 truncate">{group.name}</span>
				<span className="tabular-nums text-[10px] text-muted-foreground/70">
					{group.projectKeys.length}
				</span>
				<Chevron
					aria-hidden="true"
					className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100"
				/>
			</div>
			<Menu open={menuOpen} onOpenChange={setMenuOpen}>
				<MenuPopup
					anchor={anchorRef.current ?? undefined}
					align="start"
					side="bottom"
					className="min-w-[180px]"
				>
					<MenuItem onClick={onRename}>
						<HugeiconsIcon icon={PencilIcon} className="size-3.5" />
						{uiMessage("projects:projects_sidebar_rename")}
					</MenuItem>
					<MenuSeparator />
					<IconColorPicker value={group.iconColor} onChange={onSetIconColor} />
					<MenuSeparator />
					<MenuItem onClick={onDissolve}>
						<HugeiconsIcon icon={Delete02Icon} className="size-3.5" />
						{uiMessage("projects:projects_sidebar_ungroup")}
					</MenuItem>
				</MenuPopup>
			</Menu>
			{group.collapsed ? null : (
				<ul className="ms-2 flex flex-col gap-0.5 border-s border-sidebar-border/50 ps-1">
					{group.projectKeys.length === 0 ? (
						<li
							{...emptyDropProps}
							className={cn(
								"rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors",
								emptyDropActive &&
									"bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-inset ring-foreground/30",
							)}
						>
							{uiMessage("projects:projects_sidebar_drag_projects_here")}
						</li>
					) : (
						children
					)}
				</ul>
			)}
		</li>
	);
}

function SidebarLogicalRow({
	group,
	folders,
	origins,
	chatsByProject,
	sessionsByProject,
	cloudChats,
	activeEnvironmentId,
	expanded,
	nested = false,
	dropLine,
	dragProps,
	onToggleExpanded,
	onToggleKey,
	onSelect,
	onRemove,
	organize,
}: {
	group: LogicalProjectGroup;
	folders: ReturnType<typeof useWorkspaceStore.getState>["folders"];
	origins: Readonly<Record<string, GitOriginInfo | null>>;
	chatsByProject: Readonly<Record<string, ReadonlyArray<Chat>>>;
	sessionsByProject: Readonly<
		Record<
			string,
			ReadonlyArray<{
				readonly id: SessionId;
				readonly chatId: ChatId;
				readonly archivedAt: Date | null;
				readonly status: SessionStatus;
			}>
		>
	>;
	cloudChats: ReadonlyArray<CloudChatSummary>;
	activeEnvironmentId: string;
	expanded: Record<string, boolean>;
	nested?: boolean;
	dropLine: SidebarDropLine | null;
	dragProps: ReturnType<Organize["projectDragProps"]>;
	onToggleExpanded: (environmentId: string, id: FolderId) => void;
	onToggleKey: (key: string) => void;
	onSelect: (folderId: FolderId) => Promise<void>;
	onRemove: (folderId: FolderId) => Promise<void>;
	organize: Organize;
}) {
	const activeMember = group.members.find((member) => member.isActive);
	const folder =
		activeMember === undefined
			? undefined
			: folders.find((entry) => entry.id === activeMember.folderId);
	if (activeMember !== undefined && folder !== undefined) {
		return (
			<ProjectGroup
				id={folder.id}
				name={folder.name}
				path={folder.path}
				origin={origins[folder.id] ?? null}
				isExpanded={
					expanded[environmentProjectKey(activeEnvironmentId, folder.id)] ===
					true
				}
				chats={chatsByProject[folder.id] ?? []}
				projectSessions={sessionsByProject[folder.id] ?? []}
				remoteChats={remoteChatRows(group)}
				cloudChats={cloudChats.filter(
					(chat) =>
						chat.repositoryIdentity ===
						repositoryIdentityForOrigin(origins[folder.id]),
				)}
				environmentId={EnvironmentId.make(activeEnvironmentId)}
				nested={nested}
				dropLine={dropLine}
				dragProps={dragProps}
				organize={organize}
				projectKey={group.key}
				onSelect={() => void onSelect(folder.id)}
				onToggleExpanded={() =>
					onToggleExpanded(activeEnvironmentId, folder.id)
				}
				onRemove={() => void onRemove(folder.id)}
			/>
		);
	}
	return (
		<LogicalCatalogGroup
			group={group}
			isExpanded={expanded[group.key] === true}
			nested={nested}
			dropLine={dropLine}
			dragProps={dragProps}
			onToggle={() => onToggleKey(group.key)}
		/>
	);
}

function SidebarFolderRow({
	folder,
	origins,
	chatsByProject,
	sessionsByProject,
	cloudChats,
	activeEnvironmentId,
	expanded,
	nested = false,
	dropLine,
	dragProps,
	onToggleExpanded,
	onSelect,
	onRemove,
	organize,
}: {
	folder: Folder;
	origins: Readonly<Record<string, GitOriginInfo | null>>;
	chatsByProject: Readonly<Record<string, ReadonlyArray<Chat>>>;
	sessionsByProject: Readonly<
		Record<
			string,
			ReadonlyArray<{
				readonly id: SessionId;
				readonly chatId: ChatId;
				readonly archivedAt: Date | null;
				readonly status: SessionStatus;
			}>
		>
	>;
	cloudChats: ReadonlyArray<CloudChatSummary>;
	activeEnvironmentId: string;
	expanded: Record<string, boolean>;
	nested?: boolean;
	dropLine: SidebarDropLine | null;
	dragProps: ReturnType<Organize["projectDragProps"]>;
	onToggleExpanded: (environmentId: string, id: FolderId) => void;
	onSelect: (folderId: FolderId) => Promise<void>;
	onRemove: (folderId: FolderId) => Promise<void>;
	organize: Organize;
}) {
	return (
		<ProjectGroup
			id={folder.id}
			name={folder.name}
			path={folder.path}
			origin={origins[folder.id] ?? null}
			isExpanded={
				expanded[environmentProjectKey(activeEnvironmentId, folder.id)] === true
			}
			chats={chatsByProject[folder.id] ?? []}
			projectSessions={sessionsByProject[folder.id] ?? []}
			cloudChats={cloudChats.filter(
				(chat) =>
					chat.repositoryIdentity ===
					repositoryIdentityForOrigin(origins[folder.id]),
			)}
			environmentId={EnvironmentId.make(activeEnvironmentId)}
			nested={nested}
			dropLine={dropLine}
			dragProps={dragProps}
			organize={organize}
			projectKey={folder.id}
			onSelect={() => void onSelect(folder.id)}
			onToggleExpanded={() => onToggleExpanded(activeEnvironmentId, folder.id)}
			onRemove={() => void onRemove(folder.id)}
		/>
	);
}

function SidebarActions() {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);
	const pluginsOpen = useUiStore(
		(state) => state.view === "chat" && state.activeMainTab === "plugins",
	);

	const { isSignedIn } = useAuth();

	return (
		<div className="flex flex-col gap-0.5 px-1.5 py-1">
			<SidebarActionRow
				icon={Edit01Icon}
				label={uiMessage("projects:projects_sidebar_new_chat")}
				shortcut={formatShortcut("new-chat")}
				onClick={() => dispatchCommand("new-chat")}
			/>
			<SidebarActionRow
				icon={FolderAddIcon}
				label={uiMessage("projects:projects_sidebar_new_project")}
				onClick={() => dispatchCommand("open-project")}
			/>
			{isSignedIn && (
				<SidebarActionRow
					icon={PuzzleIcon}
					label={uiMessage("projects:projects_sidebar_plugins")}
					active={pluginsOpen}
					onClick={() => openPluginsPage()}
				/>
			)}
		</div>
	);
}

function SidebarActionRow({
	icon,
	label,
	shortcut,
	active = false,
	onClick,
}: {
	icon: IconSvgElement;
	label: string;
	shortcut?: string;
	active?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-current={active ? "page" : undefined}
			className={cn(
				"flex min-h-6 w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-left text-[12px] transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				active
					? "bg-sidebar-accent text-sidebar-accent-foreground"
					: "text-muted-foreground",
			)}
		>
			<HugeiconsIcon icon={icon} className="size-4 shrink-0" />
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{shortcut !== undefined && shortcut !== "" ? (
				<kbd className="shrink-0 font-sans text-[12px] text-muted-foreground">
					{shortcut}
				</kbd>
			) : null}
		</button>
	);
}

function SidebarFooter() {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	const setView = useUiStore((state) => state.setView);

	return (
		<div className="flex h-9 items-center justify-between px-2">
			<SidebarAccount />
			<div className="flex items-center gap-0.5">
				{!isHostedProduct() && <SidebarAgentCount />}
				{!isHostedProduct() && (
					<Suspense fallback={<span className="size-7" />}>
						<UsageLimitsMenu />
					</Suspense>
				)}
				<SidebarFooterIcon
					icon={Settings01Icon}
					label={uiMessage("common:settings")}
					onClick={() => setView("settings")}
				/>
			</div>
		</div>
	);
}

function SidebarAgentCount() {
	const activity = useSyncExternalStore(
		subscribePowerRuntimeActivity,
		getPowerRuntimeActivity,
		getPowerRuntimeActivity,
	);
	const { activeAgents, agentsConfirmed } = activity;
	const label = agentsConfirmed
		? activeAgentCountLabel(activeAgents)
		: "Local agent status unavailable — reconnecting to this computer";

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						role="status"
						aria-label={label}
						className="inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-sm leading-none tabular-nums text-muted-foreground"
					>
						{agentsConfirmed && activeAgents > 0 ? (
							<AgentActivityOrb state="working" label={label} />
						) : (
							<HugeiconsIcon icon={Robot01Icon} className="size-3.5" />
						)}
						<span>{agentsConfirmed ? activeAgents : "—"}</span>
					</span>
				}
			/>
			<TooltipPopup side="top">{label}</TooltipPopup>
		</Tooltip>
	);
}

function SidebarPlan() {
	const { message: uiMessage } = useUiMessages(["projects"]);
	const { user } = useAuth();
	const setView = useUiStore((s) => s.setView);
	const setSettingsSection = useUiStore((s) => s.setSettingsSection);
	const [entitled, setEntitled] = useState<boolean | null>(null);
	const [opening, setOpening] = useState(false);
	useEffect(() => {
		if (!user?.id) return;
		let live = true;
		setEntitled(null);
		void loadCloudEntitlements()
			.then((result) => {
				if (live) setEntitled(hasCloudEntitlement(result));
			})
			.catch(() => {
				if (live) setEntitled(false);
			});
		return () => {
			live = false;
		};
	}, [user?.id]);
	if (entitled === null) return <span className="h-7" />;
	if (!entitled)
		return (
			<DitherActionButton
				className="px-2.5"
				loading={opening}
				onClick={() => {
					setOpening(true);
					void startCloudCheckout()
						.catch(() => undefined)
						.finally(() => setOpening(false));
				}}
			>
				{uiMessage("projects:projects_sidebar_upgrade")}
			</DitherActionButton>
		);
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={() => {
							setSettingsSection(
								cloudWorkspaceBetaAvailable()
									? { kind: "machines" }
									: { kind: "general" },
							);
							setView("settings");
						}}
						className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<DitherCloudIcon className="size-3.5" />
						{uiMessage("projects:projects_sidebar_plan_cloud")}
					</button>
				}
			/>
			<TooltipPopup side="top">
				{uiMessage("projects:projects_sidebar_plan_cloud_tooltip")}
			</TooltipPopup>
		</Tooltip>
	);
}

function SidebarAccount() {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	const {
		isSignedIn,
		isLoading,
		isUnavailable,
		user,
		name,
		signingIn,
		signIn,
	} = useAuth();
	const setView = useUiStore((s) => s.setView);
	const setSettingsSection = useUiStore((s) => s.setSettingsSection);

	const _initial = (name || user?.email || "?").charAt(0).toUpperCase();

	const label = isUnavailable
		? "Account unavailable"
		: isLoading
			? "Loading account"
			: isSignedIn
				? "Profile"
				: signingIn
					? "Signing in"
					: "Sign in";
	const openAccount = () => {
		if (isLoading || isUnavailable || signingIn) return;
		if (!isSignedIn) {
			void signIn();
			return;
		}
		setSettingsSection({ kind: "general" });
		setView("settings");
	};

	if (isSignedIn) return <SidebarPlan />;
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={openAccount}
						disabled={isLoading || isUnavailable || signingIn}
						aria-label={label}
						className={cn(
							"inline-flex h-7 min-w-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
							isHostedProduct() ? "gap-1.5 px-2 text-[12px]" : "w-7",
						)}
					>
						{isLoading ? (
							<HugeiconsIcon icon={UserCircleIcon} className="size-4" />
						) : (
							<HugeiconsIcon icon={Login03Icon} className="size-4" />
						)}
						{isHostedProduct() && (
							<span className="truncate">
								{name || uiMessage("projects:projects_sidebar_zuse_account")}
							</span>
						)}
					</button>
				}
			/>
			<TooltipPopup side="top">{label}</TooltipPopup>
		</Tooltip>
	);
}

function SidebarFooterIcon({
	icon,
	label,
	onClick,
	onPointerEnter,
	onFocus,
}: {
	icon: IconSvgElement;
	label: string;
	onClick: () => void;
	onPointerEnter?: () => void;
	onFocus?: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={onClick}
						onPointerEnter={onPointerEnter}
						onFocus={onFocus}
						aria-label={label}
						className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<HugeiconsIcon icon={icon} className="size-4" />
					</button>
				}
			/>
			<TooltipPopup side="top">{label}</TooltipPopup>
		</Tooltip>
	);
}

type RemoteChatRow = {
	readonly ref: LogicalChatRef;
	readonly connected: boolean;
};

const remoteChatRows = (
	group: LogicalProjectGroup,
): ReadonlyArray<RemoteChatRow> => {
	const connectedEnvironments = new Set(
		group.members
			.filter((member) => member.connected)
			.map((member) => member.environmentId),
	);

	return group.chats
		.filter((ref) => !ref.live)
		.map((ref) => ({
			ref,
			connected: connectedEnvironments.has(ref.environmentId),
		}));
};

function CatalogConnectionNotice({
	entries,
}: {
	entries: ReadonlyArray<EnvironmentCatalogEntry>;
}) {
	const failing = entries.filter((entry) => entry.status === "error");
	const first = failing[0];
	if (first === undefined) return null;
	const label =
		failing.length === 1
			? `${first.label} can't connect`
			: `${failing.length} computers can't connect`;
	const detail = failing
		.map((entry) =>
			entry.error === null ? entry.label : `${entry.label}: ${entry.error}`,
		)
		.join("\n");
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={() => openAddComputerDialog()}
						className="mx-1.5 flex min-h-6 items-center gap-1.5 rounded-md px-2 text-left text-[12px] text-muted-foreground/80 outline-none hover:bg-sidebar-accent/40 hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
					>
						<span
							aria-hidden="true"
							className="size-1.5 shrink-0 rounded-full bg-muted-foreground/35"
						/>
						<span className="min-w-0 flex-1 truncate">{label}</span>
					</button>
				}
			/>
			<TooltipPopup className="max-w-64 whitespace-pre-line">
				{detail}
			</TooltipPopup>
		</Tooltip>
	);
}

function RemoteComputerIndicator({
	label,
	className,
	tooltip = true,
}: {
	readonly label: string;
	readonly className?: string;
	readonly tooltip?: boolean;
}) {
	const context = `Runs on ${label}`;
	const indicator = (
		<span
			className={cn("inline-flex shrink-0 text-muted-foreground/70", className)}
		>
			<HugeiconsIcon
				icon={ServerStack01Icon}
				aria-hidden
				className="size-3.5"
			/>
			<span className="sr-only">{context}</span>
		</span>
	);
	if (!tooltip) return indicator;
	return (
		<Tooltip>
			<TooltipTrigger render={indicator} />
			<TooltipPopup>{context}</TooltipPopup>
		</Tooltip>
	);
}

function SidebarChatHoverCard({
	title,
	repository,
	location,
	branch,
	providerId,
	model,
	status,
	goal = null,
	pullRequests = [],
}: {
	readonly title: string;
	readonly repository: string;
	readonly location: string;
	readonly branch?: string | null;
	readonly providerId?: ProviderId | null;
	readonly model?: string | null;
	readonly status: string;
	readonly goal?: ThreadGoal | null;
	readonly pullRequests?: ReadonlyArray<ChatPullRequest>;
}) {
	return (
		<div className="w-72 space-y-1 px-1 py-0.5 text-[12px]">
			<div className="mb-1.5 truncate text-[13px] font-medium text-foreground">
				{title || uiMessage("projects:projects_sidebar_new_chat")}
			</div>
			{goal !== null ? (
				<div className="mb-1.5 flex items-start gap-2">
					<GoalGlyph goal={goal} />
					<div className="min-w-0 flex-1">
						<div className="text-[11px] text-muted-foreground tabular-nums">
							{uiMessage(GOAL_STATUS_MESSAGE[goal.status])} ·{" "}
							{formatElapsed(goal.timeUsedSeconds * 1000)}
						</div>
						<p className="line-clamp-2 text-foreground/80">{goal.objective}</p>
					</div>
				</div>
			) : null}
			<div className="flex items-center gap-2 text-muted-foreground">
				<HugeiconsIcon icon={Folder01Icon} className="size-3.5" />
				<span className="truncate">{repository}</span>
			</div>
			<div className="flex items-center gap-2 text-muted-foreground">
				<HugeiconsIcon icon={ServerStack01Icon} className="size-3.5" />
				<span className="truncate">{location}</span>
			</div>
			{branch ? (
				<div className="flex items-center gap-2 text-muted-foreground">
					<HugeiconsIcon icon={GitBranchIcon} className="size-3.5" />
					<span className="truncate">{branch}</span>
				</div>
			) : null}
			{providerId !== null && providerId !== undefined ? (
				<div className="flex items-center gap-2 text-muted-foreground">
					<ProviderIcon providerId={providerId} className="size-3.5" />
					<span className="truncate">{model || providerId}</span>
				</div>
			) : null}
			{pullRequests.length > 0 ? (
				<div className="-mx-1 border-t border-border/50 pt-1">
					<ChatPullRequestList
						pullRequests={pullRequests}
						limit={6}
						density="compact"
						interactive={false}
					/>
				</div>
			) : null}
			<div className="pt-0.5 text-[11px] text-muted-foreground/80">
				{status}
			</div>
		</div>
	);
}

/** The composer's goal mark, so a goal reads the same wherever it shows. */
function GoalGlyph({ goal }: { readonly goal: ThreadGoal }) {
	return (
		<HugeiconsIcon
			icon={DashboardSpeedIcon}
			aria-label={uiMessage(GOAL_STATUS_MESSAGE[goal.status])}
			className="size-3.5 shrink-0 text-muted-foreground"
		/>
	);
}

/** Layers + count when a chat has several linked PRs (a stack or chain). */
function LinkedPullRequestsBadge({
	pullRequests,
}: {
	readonly pullRequests: ReadonlyArray<ChatPullRequest>;
}) {
	const open = pullRequests.some((pr) => pr.state === "open");
	const merged = pullRequests.every((pr) => pr.state === "merged");
	return (
		<span
			className={cn(
				"flex items-center gap-0.5 text-[10px] tabular-nums",
				merged
					? "text-purple-400"
					: open
						? "text-success"
						: "text-muted-foreground",
			)}
		>
			<HugeiconsIcon
				icon={Layers01Icon}
				className="size-3"
				aria-hidden="true"
			/>
			{pullRequests.length}
		</span>
	);
}

function SidebarProjectHoverCard({
	name,
	path,
	chatCount,
}: {
	readonly name: string;
	readonly path: string;
	readonly chatCount: number;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	return (
		<div className="min-w-52 max-w-72 space-y-1 px-1 py-0.5 text-xs">
			<div className="mb-1.5 flex items-center gap-2 truncate text-[13px] font-medium text-foreground">
				<HugeiconsIcon icon={Folder01Icon} className="size-3.5" />
				<span className="truncate">{name}</span>
			</div>
			<div className="flex items-center gap-2 text-muted-foreground">
				<HugeiconsIcon icon={TaskDone01Icon} className="size-3.5" />
				<span>
					{uiMessage("projects:projects_sidebar_chat_count", {
						count: chatCount,
					})}
				</span>
			</div>
			<div className="flex items-center gap-2 border-t border-border/35 pt-1.5 text-muted-foreground">
				<HugeiconsIcon icon={Folder01Icon} className="size-3.5" />
				<span className="truncate">{displayPath(path)}</span>
			</div>
			<div className="flex items-center gap-2 border-t border-border/35 pt-1.5 text-muted-foreground">
				<HugeiconsIcon icon={Settings01Icon} className="size-3.5" />
				<span>{uiMessage("projects:projects_sidebar_project_settings")}</span>
			</div>
		</div>
	);
}

function LogicalCatalogGroup({
	group,
	isExpanded,
	onToggle,
	nested = false,
	dropLine = null,
	dragProps,
}: {
	group: LogicalProjectGroup;
	isExpanded: boolean;
	onToggle: () => void;
	nested?: boolean;
	dropLine?: SidebarDropLine | null;
	dragProps?: ReturnType<Organize["projectDragProps"]>;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	const preferred = preferredGroupMember(group);
	const rows = remoteChatRows(group);
	const Chevron = isExpanded ? ChevronDown : ChevronRight;
	const avatarUrl = avatarUrlFor(group.origin);
	const listId = `catalog-project-${group.key.replace(/[^\w-]/gu, "-")}`;
	const memberLabels = group.members
		.map((member) => member.environmentLabel)
		.join(", ");

	return (
		<li>
			<div
				className={cn(
					"group relative flex min-h-7 cursor-pointer select-none items-center gap-1.5 rounded-md px-2 transition-colors hover:bg-sidebar-accent/30 motion-reduce:transition-none",
					nested && "ms-0",
				)}
				{...dragProps}
			>
				<DropLine line={dropLine} />
				<button
					type="button"
					aria-expanded={isExpanded}
					aria-controls={listId}
					className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onClick={() => {
						onToggle();
					}}
				>
					<span className="relative grid size-5 shrink-0 place-items-center">
						<Avatar className="col-start-1 row-start-1 size-5 rounded transition-opacity duration-150 ease-out group-hover:opacity-0 motion-reduce:transition-none">
							{avatarUrl !== null && (
								<AvatarImage src={avatarUrl} alt={group.displayName} />
							)}
							<AvatarFallback className="rounded text-[10px]">
								{initialsOf(group.origin?.owner ?? group.displayName)}
							</AvatarFallback>
						</Avatar>
						<Chevron
							aria-hidden="true"
							className="col-start-1 row-start-1 size-3.5 text-muted-foreground opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 motion-reduce:transition-none"
						/>
					</span>
					<span className="min-w-0 flex-1 truncate text-[12px]">
						{group.displayName}
					</span>
				</button>
				{group.environmentPresence === "remote-only" ? (
					<RemoteComputerIndicator label={memberLabels} />
				) : null}
				{preferred?.connected ? (
					<button
						type="button"
						aria-label={uiMessage("projects:projects_sidebar_new_chat_in", {
							value1: String(group.displayName),
						})}
						onPointerDown={(event) => event.stopPropagation()}
						className="rounded-md p-1 text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
						onClick={(event) => {
							event.stopPropagation();
							void switchToEnvironment({
								environmentId: preferred.environmentId,
								folderId: preferred.folderId,
							}).then((result) => {
								if (result.switched && result.selectedFolderId !== null)
									openNewChatLanding(result.selectedFolderId);
							});
						}}
					>
						<HugeiconsIcon icon={Edit01Icon} className="size-3.5" />
					</button>
				) : null}
			</div>
			<div id={listId} hidden={!isExpanded}>
				<ul
					aria-label={uiMessage("projects:projects_sidebar_chats_2", {
						displayName: String(group.displayName),
					})}
				>
					{rows.length === 0 ? (
						<li className="px-12 py-1 text-[12px] text-muted-foreground">
							{uiMessage("projects:projects_sidebar_no_chats_yet")}
						</li>
					) : null}
					{rows.map((row) => (
						<CatalogChatRow
							key={`${row.ref.environmentId}:${row.ref.chat.id}`}
							chatRef={row.ref}
							connected={row.connected}
							repositoryName={group.displayName}
						/>
					))}
				</ul>
			</div>
		</li>
	);
}

function CatalogChatRow({
	chatRef,
	connected,
	repositoryName,
	variant = "tree",
}: {
	chatRef: LogicalChatRef;
	connected: boolean;
	repositoryName: string;

	variant?: "tree" | "threadList";
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	const { chat, environmentId, environmentLabel, remote, busy } = chatRef;
	const isArchived = chat.archivedAt !== null;

	const prInfo = null;
	return (
		<li>
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							type="button"
							aria-disabled={!connected}
							onClick={() => {
								if (!connected) return;
								void switchToEnvironment({
									environmentId,
									folderId: chat.projectId,
									chatId: chat.id,
								});
							}}
							className={cn(
								variant === "threadList"
									? "group relative flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left text-[12.5px] text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
									: "group flex min-h-6 w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
								connected
									? "cursor-pointer hover:bg-sidebar-accent/40"
									: "cursor-default opacity-60",
							)}
						>
							{variant === "threadList" ? (
								<ThreadListRowBody
									title={
										chat.title ||
										uiMessage("projects:projects_sidebar_new_chat")
									}
									attentionState={busy ? "running" : "idle"}
									creationPending={false}
									statusLabel={uiMessage(
										"projects:projects_sidebar_agent_running",
									)}
									prInfo={prInfo}
									stats={null}
									projectName={repositoryName}
									projectAvatarUrl={null}
									time={formatRelative(chatRecency(chat), true)}
									remoteIndicator={
										remote ? (
											<RemoteComputerIndicator
												label={environmentLabel}
												className="mr-1"
												tooltip={false}
											/>
										) : null
									}
									action={null}
								/>
							) : (
								<>
									<span className="ml-3 inline-grid size-5 shrink-0 place-items-center">
										{busy ? (
											<>
												<span
													aria-hidden="true"
													className="size-1.5 rounded-full bg-emerald-500"
												/>
												<span className="sr-only">
													{uiMessage("projects:projects_sidebar_agent_running")}
												</span>
											</>
										) : (
											<BranchIcon
												state={branchStateFor(prInfo, isArchived)}
												selected={false}
											/>
										)}
									</span>
									<span className="min-w-0 flex-1 truncate">
										{chat.title ||
											uiMessage("projects:projects_sidebar_new_chat")}
									</span>
									<div className="relative flex h-4 w-16 shrink-0 items-center justify-end">
										{remote ? (
											<RemoteComputerIndicator
												label={environmentLabel}
												className="mr-1"
												tooltip={false}
											/>
										) : null}
										<span className="tabular-nums text-[10px] text-muted-foreground">
											{formatRelative(chatRecency(chat))}
										</span>
									</div>
								</>
							)}
						</button>
					}
				/>
				<TooltipPopup
					side="right"
					align="start"
					sideOffset={8}
					className="border border-border/60 bg-popover/95 shadow-overlay-md backdrop-blur-xl"
				>
					<SidebarChatHoverCard
						title={chat.title}
						repository={repositoryName}
						location={environmentLabel}
						providerId={chatRef.providerId}
						model={chatRef.model}
						status={
							!connected
								? "Computer offline"
								: busy
									? "Agent active"
									: "Inactive"
						}
					/>
				</TooltipPopup>
			</Tooltip>
		</li>
	);
}

function ProjectGroup({
	id,
	name,
	path,
	origin,
	isExpanded,
	chats,
	projectSessions,
	remoteChats,
	cloudChats,
	environmentId,
	onSelect,
	onToggleExpanded,
	onRemove,
	nested = false,
	dropLine = null,
	dragProps,
	organize,
	projectKey,
}: {
	id: FolderId;
	name: string;
	path: string;
	origin: GitOriginInfo | null;
	isExpanded: boolean;
	chats: ReadonlyArray<Chat>;
	projectSessions: ReadonlyArray<{
		readonly id: SessionId;
		readonly chatId: ChatId;
		readonly archivedAt: Date | null;
		readonly status: SessionStatus;
	}>;

	remoteChats?: ReadonlyArray<RemoteChatRow>;

	cloudChats?: ReadonlyArray<CloudChatSummary>;
	environmentId: EnvironmentId;
	onSelect: () => void;
	onToggleExpanded: () => void;
	onRemove: () => void;
	nested?: boolean;
	dropLine?: SidebarDropLine | null;
	dragProps?: ReturnType<Organize["projectDragProps"]>;
	organize?: Organize;
	projectKey?: string;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	const displayName = origin?.repo ?? name;
	const avatarUrl = avatarUrlFor(origin);
	const fallbackText = initialsOf(origin?.owner ?? name);
	const setView = useUiStore((s) => s.setView);
	const setSettingsSection = useUiStore((s) => s.setSettingsSection);
	const setActiveMainTab = useUiStore((s) => s.setActiveMainTab);
	const openUsage = useUiStore((s) => s.openUsage);
	const hiddenArchivedChatIds = useChatsStore(
		(state) => state.hiddenArchivedChatIds,
	);
	const openRepositorySettings = () => {
		if (isCloudProjectFolder(id)) {
			setSettingsSection({ kind: "cloud", page: "repositories" });
			setView("settings");
			return;
		}
		setSettingsSection({ kind: "repository", projectId: id });
		setView("settings");
	};

	const openArchives = () => {
		if (isCloudProjectFolder(id)) return;
		onSelect();
		void useArchivePreviewStore.getState().showList(environmentId, id);
		setView("chat");
		setActiveMainTab("archives");
	};

	const openProjectUsage = () => {
		if (isCloudProjectFolder(id)) {
			setSettingsSection({ kind: "cloud", page: "billing" });
			setView("settings");
			return;
		}
		onSelect();
		openUsage("project");
	};

	const visibleChats = useMemo(() => {
		const cloudIds = new Set((cloudChats ?? []).map((row) => row.chatId));
		return chats.filter(
			(chat) =>
				chat.archivedAt === null &&
				!cloudIds.has(chat.id) &&
				!hiddenArchivedChatIds.has(chat.id),
		);
	}, [chats, cloudChats, hiddenArchivedChatIds, uiMessage]);

	const chatRows = useMemo(() => {
		const local = visibleChats.map((chat) => ({
			kind: "local" as const,
			chat,
			recency: chatRecency(chat).getTime(),
			id: chat.id,
		}));
		const remote = (remoteChats ?? []).map((row) => ({
			kind: "remote" as const,
			row,
			recency: chatRecency(row.ref.chat).getTime(),
			id: row.ref.chat.id,
		}));
		const cloud = (cloudChats ?? [])
			.filter(
				(summary) =>
					summary.archivedAt === undefined &&
					summary.desiredState !== "archived" &&
					!hiddenArchivedChatIds.has(summary.chatId),
			)
			.map((summary) => ({
				kind: "cloud" as const,
				summary,
				recency: chatRecency(summary),
				id: summary.chatId,
			}));
		return [...local, ...remote, ...cloud].sort(
			(left, right) =>
				right.recency - left.recency || left.id.localeCompare(right.id),
		);
	}, [visibleChats, remoteChats, cloudChats, hiddenArchivedChatIds, uiMessage]);

	const liveSessions = useMemo(
		() => projectSessions.filter((session) => session.archivedAt === null),
		[projectSessions, uiMessage],
	);
	const liveSessionIds = useMemo(
		() => liveSessions.map((session) => session.id),
		[liveSessions, uiMessage],
	);
	const liveTimelineRefs = useMemo(
		() => liveSessionIds.map((sessionId) => ({ environmentId, sessionId })),
		[environmentId, liveSessionIds, uiMessage],
	);
	const liveTimelines = useRendererSessionTimelines(
		liveTimelineRefs,
		"cache-only",
	);
	const questionAttachmentsByKey =
		useEnvironmentQuestionAttachments(environmentId).data?.attachmentsByKey ??
		{};
	const headerRunning = useMemo(
		() =>
			mergeChatAttentionStates(
				liveTimelines.map((timeline) =>
					executionAttentionState(
						isSessionRuntimeBusy(timeline.runtime),
						timeline.presentation.health,
					),
				),
			),
		[liveTimelines, uiMessage],
	);
	const headerMessageAttention = useMemo(
		() =>
			mergeChatAttentionStates(
				liveTimelines.map((timeline) =>
					deriveChatAttentionState(
						timeline.messages,
						false,
						filterActionableQuestionInteractions(
							timeline.ref.sessionId,
							timeline.presentation.interactions.map(
								(item) => item.interaction,
							),
							questionAttachmentsByKey,
						),
					),
				),
			),
		[liveTimelines, questionAttachmentsByKey, uiMessage],
	);
	const liveSessionIdSet = useMemo(
		() => new Set(liveSessionIds),
		[liveSessionIds, uiMessage],
	);

	const permissionRequests =
		useEnvironmentPermissions().data?.requestsById ?? {};
	const headerPermissionAttention = derivePermissionAttention(
		Object.values(permissionRequests),
		liveSessionIdSet,
	);
	const headerAttention = mergeChatAttentionStates([
		headerRunning,
		headerMessageAttention,
		headerPermissionAttention,
	]);
	const showHeaderAttention = headerAttention !== "idle" && !isExpanded;

	const [menuOpen, setMenuOpen] = useState(false);
	const anchorRef = useRef<{ getBoundingClientRect: () => DOMRect } | null>(
		null,
	);
	const Chevron = isExpanded ? ChevronDown : ChevronRight;

	return (
		<li>
			<Tooltip>
				<TooltipTrigger
					render={
						<div
							{...dragProps}
							className={cn(
								"group relative flex cursor-pointer select-none items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors hover:bg-sidebar-accent/40 focus-visible:bg-sidebar-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
								nested && "ms-0",
							)}
						>
							<button
								type="button"
								aria-expanded={isExpanded}
								onContextMenu={(event) => {
									event.preventDefault();
									event.stopPropagation();
									const rect = new DOMRect(event.clientX, event.clientY, 0, 0);
									anchorRef.current = { getBoundingClientRect: () => rect };
									setMenuOpen(true);
								}}
								onClick={onToggleExpanded}
								className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<span className="sr-only">
									{uiMessage(isExpanded ? "common:collapse" : "common:expand", {
										title: displayName,
									})}
								</span>
							</button>
							<DropLine line={dropLine} />

							<div className="pointer-events-none relative grid size-5 shrink-0 place-items-center">
								<Avatar
									className={cn(
										"col-start-1 row-start-1 size-5 rounded transition-opacity duration-150 ease-out",
										"group-hover:opacity-0 motion-reduce:transition-none",
										showHeaderAttention && "opacity-0",
									)}
								>
									{avatarUrl !== null && (
										<AvatarImage src={avatarUrl} alt={displayName} />
									)}
									<AvatarFallback className="rounded text-[10px]">
										{fallbackText}
									</AvatarFallback>
								</Avatar>
								{showHeaderAttention && (
									<ChatAttentionIcon
										state={headerAttention}
										className={cn(
											"col-start-1 row-start-1 transition-opacity duration-150 ease-out",
											"group-hover:opacity-0 motion-reduce:transition-none",
										)}
										context="project"
									/>
								)}
								<Chevron
									aria-hidden="true"
									className={cn(
										"col-start-1 row-start-1 size-3.5 text-muted-foreground opacity-0 transition-opacity duration-150 ease-out",
										"group-hover:opacity-100 motion-reduce:transition-none",
									)}
								/>
							</div>
							<span
								className="pointer-events-none min-w-0 flex-1 truncate text-[12px]"
								title={
									origin
										? `${origin.owner}/${origin.repo} · ${displayPath(path)}`
										: displayPath(path)
								}
							>
								{displayName}
							</span>
							<Tooltip>
								<TooltipTrigger
									render={
										<button
											type="button"
											onClick={(event) => {
												event.stopPropagation();
												openRepositorySettings();
											}}
											className="relative z-10 rounded-md p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
											onPointerDown={(event) => event.stopPropagation()}
											aria-label={uiMessage(
												"projects:projects_sidebar_settings_for",
												{ displayName: String(displayName) },
											)}
										>
											<HugeiconsIcon
												icon={Settings01Icon}
												className="size-3.5"
											/>
										</button>
									}
								/>
								<TooltipPopup>
									{uiMessage("projects:projects_sidebar_repository_settings")}
								</TooltipPopup>
							</Tooltip>
							<NewChatButton projectId={id} />
						</div>
					}
				/>
				<TooltipPopup
					side="right"
					align="start"
					sideOffset={8}
					className="border border-border/60 bg-popover/95 shadow-overlay-md backdrop-blur-xl"
				>
					<SidebarProjectHoverCard
						name={displayName}
						path={path}
						chatCount={chatRows.length}
					/>
				</TooltipPopup>
			</Tooltip>

			<ProjectContextMenu
				cloudOnly={isCloudProjectFolder(id)}
				open={menuOpen}
				anchor={anchorRef.current}
				onOpenChange={setMenuOpen}
				onOpenSettings={openRepositorySettings}
				onOpenArchives={openArchives}
				onOpenUsage={openProjectUsage}
				onRemove={onRemove}
				groups={organize?.groups ?? []}
				currentGroupId={
					projectKey === undefined
						? null
						: (organize?.inGroupId(projectKey) ?? null)
				}
				onNewGroup={
					projectKey === undefined
						? undefined
						: () =>
								organize?.setGroupDialog({
									kind: "create",
									projectKeys: [projectKey],
								})
				}
				onAddToGroup={
					projectKey === undefined
						? undefined
						: (groupId) => organize?.addToGroup(projectKey, groupId)
				}
				onRemoveFromGroup={
					projectKey === undefined
						? undefined
						: () => organize?.removeFromGroup(projectKey)
				}
			/>
			<div hidden={!isExpanded}>
				<ul
					aria-label={uiMessage("projects:projects_sidebar_chats_2", {
						displayName: String(displayName),
					})}
				>
					{chatRows.length === 0 && (
						<li className="px-12 py-1 text-[12px] text-muted-foreground">
							{uiMessage("projects:projects_sidebar_no_chats_yet")}
						</li>
					)}
					{chatRows.map((entry) =>
						entry.kind === "local" ? (
							<ChatRow
								key={entry.chat.id}
								chat={entry.chat}
								projectRoot={path}
							/>
						) : entry.kind === "remote" ? (
							<CatalogChatRow
								key={`${entry.row.ref.environmentId}:${entry.row.ref.chat.id}`}
								chatRef={entry.row.ref}
								connected={entry.row.connected}
								repositoryName={displayName}
							/>
						) : (
							<CloudChatRow
								key={entry.summary.chatId}
								summary={entry.summary}
								projectId={id}
							/>
						),
					)}
				</ul>
			</div>
		</li>
	);
}

/** Cloud marker for a cloud chat row, or the Slack mark when Slack started it. */
function CloudChatIndicator({
	slack,
	label,
	className,
}: {
	readonly slack: boolean;
	readonly label: string;
	readonly className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground/60",
				className,
			)}
			role="img"
			aria-label={label}
			title={slack ? label : undefined}
		>
			{slack ? (
				<SlackIcon monochrome className="size-3" />
			) : (
				<DitherCloudIcon className="size-4" />
			)}
		</span>
	);
}

function CloudChatRow({
	summary,
	projectId,
	projectName,
	variant = "tree",
}: {
	readonly summary: CloudChatSummary;
	readonly projectId?: FolderId;

	readonly projectName?: string;

	readonly variant?: "tree" | "threadList";
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	const selectedChatId = useChatsStore((state) => state.selectedChatId);
	const archive = useCloudChatsStore((state) => state.archive);
	const [archiving, setArchiving] = useState(false);
	const timeline = useOptionalRendererSessionTimeline(
		cloudSummaryActiveSessionId(summary),
		"cache-only",
		EnvironmentId.make(summary.workspaceId),
	);
	const shell = useEnvironmentShellResource(
		EnvironmentId.make(summary.workspaceId),
		"cache-only",
	);
	const questionAttachmentsByKey =
		useEnvironmentQuestionAttachments(EnvironmentId.make(summary.workspaceId))
			.data?.attachmentsByKey ?? {};
	const activity = deriveCloudChatActivity({
		summary,
		connection: shell.connection,
		runtime: timeline.runtime,
		timeline: timeline.view,
	});
	const loading = cloudChatShowsLoading(activity, shell.connection, summary);
	const slack = summary.source === "slack";
	const label = slack
		? uiMessage("projects:projects_sidebar_started_from_slack")
		: uiMessage("projects:projects_sidebar_cloud");
	const archivePending =
		summary.desiredState === "archived" && summary.state !== "failed";
	const liveAttention = useChatAttention(
		{ id: summary.chatId },
		summary.workspaceId,
		false,
	);
	const summaryAttention = deriveChatAttentionState(
		timeline.messages,
		cloudChatShowsWorking(activity, timeline.view.pendingCommands),
		filterActionableQuestionInteractions(
			summary.initialSessionId,
			timeline.presentation.interactions.map((item) => item.interaction),
			questionAttachmentsByKey,
		),
		timeline.presentation.health,
	);

	const attentionState = mergeChatAttentionStates([
		liveAttention.attentionState,
		summaryAttention,
	]);

	const selected = selectedChatId === summary.chatId;
	const open = () => {
		if (isHostedProduct()) selectHostedCloudHome(projectId);
		void openCloudChat(summary, projectId).catch((cause) =>
			toastManager.add({
				type: "error",
				title: uiMessage(
					"projects:projects_sidebar_cloud_chat_could_not_refresh",
				),
				description: formatError(cause),
			}),
		);
	};
	const archiveChat = () => {
		if (archiving || archivePending) return;
		setArchiving(true);
		void archive(summary)
			.catch((cause) =>
				toastManager.add({
					type: "error",
					title: uiMessage(
						"projects:projects_sidebar_cloud_chat_could_not_be_archived",
					),
					description: formatError(cause),
				}),
			)
			.finally(() => setArchiving(false));
	};
	const archiveLabel =
		summary.state === "failed" && summary.desiredState === "archived"
			? uiMessage("projects:projects_sidebar_retry_archive")
			: uiMessage("projects:projects_sidebar_archive");
	return (
		<li>
			<Tooltip>
				<TooltipTrigger
					render={
						/* biome-ignore lint/a11y/useSemanticElements: the row contains a nested archive action. */
						<div
							role="button"
							tabIndex={0}
							aria-label={`${summary.title}. ${label}`}
							className={cn(
								variant === "threadList"
									? "group relative flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 text-left text-[12.5px] text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent/40 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
									: "group flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded-md py-1.5 pr-2 pl-1 text-left text-[12px] text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent/40 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
								selected && "bg-sidebar-accent text-sidebar-accent-foreground",
							)}
							onClick={open}
							onKeyDown={(event) => {
								if (isInputComposing(event)) return;

								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									open();
								}
							}}
						>
							{variant === "threadList" ? (
								<ThreadListRowBody
									title={summary.title}
									attentionState={attentionState}
									creationPending={false}
									loading={loading}
									statusLabel={
										loading && attentionState === "idle"
											? uiMessage("common:loading")
											: chatAttentionLabel(attentionState)
									}
									prInfo={null}
									stats={null}
									projectName={projectName ?? summary.repositoryDisplayName}
									projectAvatarUrl={avatarUrlForRepositoryIdentity(
										summary.repositoryIdentity,
									)}
									time={formatRelative(new Date(chatRecency(summary)), true)}
									remoteIndicator={
										<CloudChatIndicator
											slack={slack}
											label={label}
											className="mr-1"
										/>
									}
									action={
										<ChatArchiveButton
											icon={ArchiveArrowDownIcon}
											label={archiveLabel}
											chatTitle={summary.title}
											archiving={archiving}
											busy={archiving || archivePending}
											onClick={archiveChat}
										/>
									}
								/>
							) : (
								<>
									<span className="ml-3 inline-grid size-5 shrink-0 place-items-center">
										{attentionState !== "idle" ? (
											<ChatAttentionIcon
												state={attentionState}
												selected={selected}
											/>
										) : loading ? (
											<Spinner className="size-3.5" />
										) : (
											<BranchIcon state="default" selected={selected} />
										)}
									</span>
									<span className="min-w-0 flex-1 truncate">
										{summary.title}
									</span>
									<div className="flex h-4 w-20 shrink-0 items-center justify-end gap-1">
										<CloudChatIndicator slack={slack} label={label} />
										<span className="tabular-nums text-[10px] text-muted-foreground transition-opacity duration-150 ease-out motion-reduce:transition-none group-hover:hidden">
											{formatRelative(new Date(chatRecency(summary)))}
										</span>
										<button
											type="button"
											disabled={archiving || archivePending}
											onClick={(event) => {
												event.stopPropagation();
												archiveChat();
											}}
											className={cn(
												"items-center rounded-md p-0.5 text-muted-foreground transition-opacity duration-150 ease-out hover:text-sidebar-accent-foreground motion-reduce:transition-none group-focus-within:flex",
												archiving ? "flex" : "hidden group-hover:flex",
											)}
											aria-label={`${summary.state === "failed" && summary.desiredState === "archived" ? "Retry archiving" : "Archive"} ${summary.title}`}
											title={archiveLabel}
										>
											{archiving ? (
												<Spinner className="size-3.5" />
											) : (
												<HugeiconsIcon
													icon={ArchiveArrowDownIcon}
													className="size-3.5"
												/>
											)}
										</button>
									</div>
								</>
							)}
						</div>
					}
				/>
				<TooltipPopup
					side="right"
					align="start"
					sideOffset={8}
					className="border border-border/60 bg-popover/95 shadow-overlay-md backdrop-blur-xl"
				>
					<SidebarChatHoverCard
						title={summary.title}
						repository={summary.repositoryDisplayName}
						location="Cloud workspace"
						branch={summary.branch}
						providerId={summary.agent}
						model={summary.model}
						status={label}
					/>
				</TooltipPopup>
			</Tooltip>
		</li>
	);
}

function AddToGroupFlyout({
	groups,
	onAddToGroup,
	onClose,
}: {
	groups: Organize["groups"];
	onAddToGroup: (groupId: string) => void;
	onClose: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	const itemRef = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	const closeTimer = useRef<number | null>(null);

	const show = () => {
		if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
		const rect = itemRef.current?.getBoundingClientRect();
		if (rect !== undefined) {
			setPos({ top: rect.top, left: rect.right + 4 });
		}
		setOpen(true);
	};
	const hide = () => {
		closeTimer.current = window.setTimeout(() => setOpen(false), 120);
	};

	return (
		<div
			ref={itemRef}
			onPointerEnter={show}
			onPointerLeave={hide}
			className="flex min-h-7 w-full cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-accent hover:text-accent-foreground"
		>
			<HugeiconsIcon icon={Folder01Icon} className="size-3.5" />
			<span className="min-w-0 flex-1">
				{uiMessage("projects:projects_sidebar_add_to_group")}
			</span>
			<ChevronRight className="size-3.5 opacity-80" />
			{open && pos !== null
				? createPortal(
						<div
							onPointerEnter={show}
							onPointerLeave={hide}
							className="fixed z-50 min-w-[160px] rounded-lg border-glass bg-glass p-1 text-popover-foreground"
							style={{ top: pos.top, left: pos.left }}
						>
							{groups.map((group) => (
								<button
									key={group.id}
									type="button"
									onClick={() => {
										onAddToGroup(group.id);
										onClose();
									}}
									className="flex min-h-7 w-full items-center rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-accent hover:text-accent-foreground"
								>
									{group.name}
								</button>
							))}
						</div>,
						document.body,
					)
				: null}
		</div>
	);
}

function ProjectContextMenu({
	cloudOnly = false,
	open,
	anchor,
	onOpenChange,
	onOpenSettings,
	onOpenArchives,
	onOpenUsage,
	onRemove,
	groups,
	currentGroupId,
	onNewGroup,
	onAddToGroup,
	onRemoveFromGroup,
}: {
	cloudOnly?: boolean;
	open: boolean;
	anchor: { getBoundingClientRect: () => DOMRect } | null;
	onOpenChange: (open: boolean) => void;
	onOpenSettings: () => void;
	onOpenArchives: () => void;
	onOpenUsage: () => void;
	onRemove: () => void;
	groups: Organize["groups"];
	currentGroupId: string | null;
	onNewGroup?: () => void;
	onAddToGroup?: (groupId: string) => void;
	onRemoveFromGroup?: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	const otherGroups = groups.filter((group) => group.id !== currentGroupId);
	return (
		<Menu open={open} onOpenChange={onOpenChange} modal={false}>
			<MenuPopup
				anchor={anchor ?? undefined}
				align="start"
				side="bottom"
				className="min-w-[196px]"
			>
				<MenuItem
					onClick={isHostedProduct() ? openProjectSetupDialog : onOpenSettings}
					className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-sidebar-accent"
				>
					<HugeiconsIcon icon={Settings01Icon} className="size-3.5" />
					{uiMessage("common:settings")}
				</MenuItem>
				<MenuItem
					onClick={onOpenArchives}
					disabled={cloudOnly}
					className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-sidebar-accent"
				>
					<HugeiconsIcon icon={ArchiveIcon} className="size-3.5" />
					{uiMessage("projects:projects_sidebar_archived_chats")}
				</MenuItem>
				<MenuItem
					onClick={isHostedProduct() ? openProjectSetupDialog : onOpenUsage}
					className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-sidebar-accent"
				>
					<HugeiconsIcon icon={Analytics01Icon} className="size-3.5" />
					{uiMessage("projects:projects_sidebar_usage")}
				</MenuItem>
				<MenuSeparator />
				{onNewGroup !== undefined ? (
					<MenuItem
						onClick={onNewGroup}
						className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-sidebar-accent"
					>
						<HugeiconsIcon icon={FolderAddIcon} className="size-3.5" />
						{uiMessage("projects:projects_sidebar_new_group")}
					</MenuItem>
				) : null}
				{onAddToGroup !== undefined && otherGroups.length > 0 ? (
					<AddToGroupFlyout
						groups={otherGroups}
						onAddToGroup={onAddToGroup}
						onClose={() => onOpenChange(false)}
					/>
				) : null}
				{currentGroupId !== null && onRemoveFromGroup !== undefined ? (
					<MenuItem
						onClick={onRemoveFromGroup}
						className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-sidebar-accent"
					>
						{uiMessage("projects:projects_sidebar_remove_from_group")}
					</MenuItem>
				) : null}
				<MenuSeparator />
				<MenuItem
					onClick={onRemove}
					className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-red-300 hover:bg-red-500/20"
				>
					<HugeiconsIcon icon={Delete02Icon} className="size-3.5" />
					{uiMessage("projects:projects_sidebar_remove_project")}
				</MenuItem>
			</MenuPopup>
		</Menu>
	);
}

/**
 * Start a brand-new chat in the given project. Creation is deferred to the
 * first message: clicking "New chat" must NOT branch a worktree or spin up a
 * session — it just clears the active selection so `MainShell` falls through
 * to `<ChatLanding/>` ("What should we build in <project>?"). The landing's
 * `submit()` is the sole creation path (worktree → chat → queue). Reads from
 * stores directly so callers (the sidebar button + the Cmd+N menu shortcut)
 * don't need prop drilling.
 */
export function createNewSession(projectId: FolderId): void {
	useUiStore.getState().setActiveMainTab("chat");

	if (useWorkspaceStore.getState().selectedFolderId !== projectId) {
		void useWorkspaceStore.getState().select(projectId);
	}
	useChatsStore.getState().select(null);
}

function NewChatButton({ projectId }: { projectId: FolderId }) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	const onClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (isHostedProduct()) selectHostedCloudHome(projectId);
		else openNewChatLanding(projectId);
	};

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={onClick}
						onPointerDown={(event) => event.stopPropagation()}
						className="relative z-10 rounded-md p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
						aria-label={uiMessage("projects:projects_sidebar_new_chat")}
					>
						<HugeiconsIcon icon={Edit01Icon} className="size-3.5" />
					</button>
				}
			/>
			<TooltipPopup>
				<TooltipShortcut
					label={uiMessage("projects:projects_sidebar_new_chat")}
					shortcut={formatShortcut("new-chat")}
				/>
			</TooltipPopup>
		</Tooltip>
	);
}

/**
 * Tooltip body with a trailing `<kbd>` shortcut hint. Co-located here
 * because almost every shortcut-bearing tooltip lives in this file or in
 * `top-bar.tsx`; exporting keeps the markup consistent across both.
 */
export function TooltipShortcut({
	label,
	shortcut,
}: {
	label: string;
	shortcut: string;
}) {
	if (shortcut === "") return <>{label}</>;
	return (
		<span className="inline-flex items-baseline gap-2 whitespace-nowrap">
			<span>{label}</span>
			<kbd className="font-sans text-muted-foreground/80">{shortcut}</kbd>
		</span>
	);
}

function ChatRow({
	chat,
	projectRoot,
	projectName,
	projectAvatarUrl = null,
	variant = "tree",
}: {
	chat: Chat;
	projectRoot: string;

	projectName?: string;

	projectAvatarUrl?: string | null;

	variant?: "tree" | "threadList";
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);
	const threadList = variant === "threadList";

	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
	const selectedChatId = useChatsStore((s) => s.selectedChatId);

	const selectChat = useChatsStore((s) => s.select);
	const renameChat = useChatsStore((s) => s.rename);
	const unarchiveChat = useChatsStore((s) => s.unarchive);
	const removeChat = useChatsStore((s) => s.remove);
	const archiveProgress = useChatsStore(
		(s) => s.archiveProgressByChat[chat.id] ?? null,
	);
	const isRestoring = useArchivePreviewStore(
		(s) => s.restoringByChat[chat.id] === true,
	);
	const creationPending = useChatsStore((s) => {
		const creation = s.pendingCreationByChat[chat.id];
		return creation !== undefined && chatCreationIsInProgress(creation.phase);
	});

	const activeEnvironmentId = useEnvironmentCatalogStore(
		(s) => s.activeEnvironmentId,
	);
	const environmentLabel = useEnvironmentCatalogStore(
		(s) =>
			s.entries.find((entry) => entry.environmentId === s.activeEnvironmentId)
				?.label ?? "another computer",
	);
	const onRemoteEnvironment = activeEnvironmentId !== getLocalEnvironmentId();
	const worktreePath = useWorktreesStore((state) => {
		if (chat.worktreeId === null) return projectRoot;
		return (
			(state.byProject[chat.projectId] ?? EMPTY_WORKTREES).find(
				(worktree) => worktree.id === chat.worktreeId,
			)?.path ?? null
		);
	});

	const gitView = useGitWorkspaceResource(
		creationPending || worktreePath === null
			? null
			: {
					environmentId: EnvironmentId.make(activeEnvironmentId),
					folderId: chat.projectId,
					worktreeId: chat.worktreeId,
					rootPath: worktreePath,
				},
		"cache-only",
	);
	const prInfo = gitView.data?.pr ?? null;
	const diffStat = gitView.data?.diffStat ?? null;

	const { chatSessions, sessionIds, attentionState, permissionAttention } =
		useChatAttention(chat, activeEnvironmentId, creationPending);
	const hoverSession =
		chatSessions.find((session) => session.id === selectedSessionId) ??
		chatSessions[0] ??
		null;
	const hoverStatus = chatAttentionLabel(attentionState, creationPending);
	const goalRef = useMemo(
		() =>
			hoverSession === null
				? null
				: {
						environmentId: EnvironmentId.make(activeEnvironmentId),
						sessionId: hoverSession.id,
					},
		[activeEnvironmentId, hoverSession?.id],
	);
	const goal = useSessionGoalResource(goalRef, "cache-only").data?.goal ?? null;
	const activeGoal = isGoalInProgress(goal) ? goal : null;
	const stackBranch = gitView.data?.status?.branch ?? prInfo?.branch ?? null;
	const stackRef = useMemo(
		() =>
			worktreePath === null
				? null
				: {
						environmentId: EnvironmentId.make(activeEnvironmentId),
						folderId: chat.projectId,
						worktreeId: chat.worktreeId,
						rootPath: worktreePath,
					},
		[activeEnvironmentId, chat.projectId, chat.worktreeId, worktreePath],
	);
	// Rows only read cached stacks; the hover card asks for this one chat's
	// stack so long sidebars never fan out `gh stack` calls.
	const stack = useGitStackStore((state) =>
		stackBranch === null || stackRef === null
			? null
			: (state.entries[gitStackKey(stackRef, stackBranch)]?.result ?? null),
	);
	const discoverStack = (open: boolean) => {
		if (!open || stackBranch === null || stackRef === null) return;
		void readGitStack(stackRef, stackBranch).catch(() => undefined);
	};
	const pullRequests = useMemo(
		() => chatPullRequests({ pr: prInfo, title: null, stack }),
		[prInfo, stack],
	);

	const sessionBelongsToChat = useMemo(() => {
		if (selectedSessionId === null) return false;
		return sessionIds.includes(selectedSessionId);
	}, [selectedSessionId, sessionIds, uiMessage]);
	const isSelected = selectedChatId === chat.id || sessionBelongsToChat;
	const isArchived = chat.archivedAt !== null;

	const isUnread =
		!isSelected &&
		(isChatUnread(chat, selectedChatId) ||
			permissionAttention === "permission");

	const branchState: BranchState = branchStateFor(prInfo, isArchived);
	const stats = diffStatsFor(diffStat, prInfo);
	const showDiff = stats !== null;

	const [renameOpen, setRenameOpen] = useState(false);
	const onRename = () => {
		setMenuOpen(false);
		void loadRenameDialog();
		setRenameOpen(true);
	};

	const onDelete = () => {
		if (!window.confirm(`Delete "${chat.title}"? This can't be undone.`))
			return;
		void removeChat(chat.id);
	};

	const [menuOpen, setMenuOpen] = useState(false);
	const anchorRef = useRef<{ getBoundingClientRect: () => DOMRect } | null>(
		null,
	);

	const onContextMenu = (e: React.MouseEvent) => {
		e.preventDefault();
		const x = e.clientX;
		const y = e.clientY;
		const rect = new DOMRect(x, y, 0, 0);
		anchorRef.current = { getBoundingClientRect: () => rect };
		setMenuOpen(true);
	};

	const primaryActionIcon = isArchived
		? ArchiveArrowUpIcon
		: ArchiveArrowDownIcon;
	const isArchiving = archiveProgress !== null;
	const archiveProgressText =
		archiveProgress === null ? null : chatArchiveProgressLabel(archiveProgress);
	const primaryActionLabel = isArchived
		? "Unarchive"
		: (archiveProgressText ?? "Archive");
	const archiveChat = () => {
		if (isArchiving) return;
		void archiveChatWithConfirm(chat.id);
	};
	const restoreChat = () => {
		if (isRestoring) return;
		void unarchiveChat(chat.id).then((outcome) => {
			if (!outcome.ok) {
				toastManager.add({
					type: "error",
					title: uiMessage(
						"projects:projects_sidebar_chat_could_not_be_restored",
					),
					description: outcome.reason,
				});
			}
		});
	};
	const archiveButton = (
		<ChatArchiveButton
			icon={primaryActionIcon}
			label={primaryActionLabel}
			chatTitle={chat.title}
			archiving={isArchiving}
			busy={isArchiving || isRestoring}
			onClick={isArchived ? restoreChat : archiveChat}
		/>
	);
	const remoteIndicator = onRemoteEnvironment ? (
		<RemoteComputerIndicator
			label={environmentLabel}
			className="mr-1"
			tooltip={false}
		/>
	) : null;

	return (
		<>
			{renameOpen ? (
				<Suspense fallback={null}>
					<RenameDialog
						title={uiMessage("projects:projects_sidebar_rename_chat")}
						description={uiMessage(
							"projects:projects_sidebar_change_the_name_shown_in_the_projects_sidebar",
						)}
						label={uiMessage("projects:projects_sidebar_chat_name")}
						value={chat.title}
						open
						onOpenChange={setRenameOpen}
						onRename={(title) => renameChat(chat.id, title)}
					/>
				</Suspense>
			) : null}
			<li>
				<Tooltip onOpenChange={discoverStack}>
					<TooltipTrigger
						render={
							<div
								className={cn(
									threadList
										? "group relative flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 text-[12.5px] transition-colors"
										: "group relative flex min-h-7 cursor-pointer items-center gap-1.5 rounded-md py-1.5 pr-2 pl-1 text-[12px] transition-colors",
									isSelected &&
										"bg-sidebar-accent text-sidebar-accent-foreground",
									!isSelected &&
										isArchived &&
										"text-muted-foreground hover:bg-sidebar-accent/40",

									!isSelected &&
										!isArchived &&
										!isUnread &&
										"text-muted-foreground hover:bg-sidebar-accent/40",
									!isSelected &&
										!isArchived &&
										isUnread &&
										"font-semibold text-sidebar-foreground hover:bg-sidebar-accent/40",
								)}
								title={
									onRemoteEnvironment
										? uiMessage("projects:projects_sidebar_runs_on", {
												title: String(chat.title),
												environmentLabel: String(environmentLabel),
											})
										: chat.title
								}
							>
								<button
									type="button"
									onClick={() => selectChat(chat.id)}
									onContextMenu={onContextMenu}
									className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									<span className="sr-only">{chat.title}</span>
								</button>
								{threadList ? (
									<ThreadListRowBody
										title={chat.title}
										attentionState={attentionState}
										creationPending={creationPending}
										statusLabel={hoverStatus}
										prInfo={prInfo}
										stats={stats}
										projectName={projectName}
										projectAvatarUrl={projectAvatarUrl}
										time={formatRelative(chatRecency(chat), true)}
										remoteIndicator={remoteIndicator}
										action={archiveButton}
									/>
								) : (
									<>
										<span className="pointer-events-none ml-3 inline-grid size-5 shrink-0 place-items-center">
											{attentionState !== "idle" ? (
												<ChatAttentionIcon
													state={attentionState}
													selected={isSelected}
												/>
											) : activeGoal !== null ? (
												<GoalGlyph goal={activeGoal} />
											) : (
												<BranchIcon state={branchState} selected={isSelected} />
											)}
										</span>
										<TypewriterText
											text={chat.title}
											className="pointer-events-none min-w-0 flex-1 truncate"
										/>
										<div className="pointer-events-none relative flex h-4 min-w-16 shrink-0 items-center justify-end gap-1.5">
											{remoteIndicator}
											{pullRequests.length > 1 ? (
												<LinkedPullRequestsBadge pullRequests={pullRequests} />
											) : null}
											<span className="tabular-nums text-[10px] text-muted-foreground transition-opacity duration-150 ease-out motion-reduce:transition-none group-hover:hidden">
												{showDiff && stats !== null ? (
													<>
														<span className="text-success">
															+{formatCompactNumber(stats.additions)}
														</span>{" "}
														<span className="text-danger-text">
															−{formatCompactNumber(stats.deletions)}
														</span>
													</>
												) : (
													formatRelative(chatRecency(chat))
												)}
											</span>
											{archiveButton}
										</div>
									</>
								)}
							</div>
						}
					/>
					<TooltipPopup
						side="right"
						align="start"
						sideOffset={8}
						className="border border-border/60 bg-popover/95 shadow-overlay-md backdrop-blur-xl"
					>
						<SidebarChatHoverCard
							title={chat.title}
							repository={displayPath(projectRoot)}
							location={
								onRemoteEnvironment ? environmentLabel : "This computer"
							}
							providerId={hoverSession?.providerId}
							model={hoverSession?.model}
							status={hoverStatus}
							goal={activeGoal}
							pullRequests={pullRequests}
						/>
					</TooltipPopup>
				</Tooltip>
			</li>
			<Menu open={menuOpen} onOpenChange={setMenuOpen}>
				<MenuPopup
					anchor={anchorRef.current ?? undefined}
					align="start"
					side="bottom"
					className="min-w-40"
				>
					<MenuItem
						onClick={onRename}
						className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-sidebar-accent"
					>
						<HugeiconsIcon icon={PencilIcon} className="size-3.5" />
						{uiMessage("projects:projects_sidebar_rename")}
					</MenuItem>
					{isArchived ? (
						<MenuItem
							disabled={isRestoring}
							onClick={restoreChat}
							className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-sidebar-accent"
						>
							{isRestoring ? (
								<Spinner className="size-3.5" />
							) : (
								<HugeiconsIcon icon={ArchiveArrowUpIcon} className="size-3.5" />
							)}
							{uiMessage("projects:projects_sidebar_unarchive")}
						</MenuItem>
					) : (
						<MenuItem
							disabled={isArchiving}
							onClick={archiveChat}
							className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-sidebar-accent"
						>
							{isArchiving ? (
								<Spinner className="size-3.5" />
							) : (
								<HugeiconsIcon
									icon={ArchiveArrowDownIcon}
									className="size-3.5"
								/>
							)}
							{archiveProgressText ??
								uiMessage("projects:projects_sidebar_archive")}
						</MenuItem>
					)}
					<MenuItem
						onClick={onDelete}
						className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-red-300 hover:bg-red-500/20"
					>
						<HugeiconsIcon icon={Delete02Icon} className="size-3.5" />
						{uiMessage("common:delete")}
					</MenuItem>
				</MenuPopup>
			</Menu>
		</>
	);
}

function ThreadListRowBody({
	loading = false,
	title,
	attentionState,
	creationPending,
	statusLabel,
	prInfo,
	stats,
	projectName,
	projectAvatarUrl,
	time,
	remoteIndicator,
	action,
}: {
	title: string;
	attentionState: ChatAttentionState;
	loading?: boolean;
	creationPending: boolean;
	statusLabel: string;
	prInfo: GitPrInfo | null;
	stats: GitDiffStat | null;
	projectName: string | undefined;
	projectAvatarUrl: string | null;
	time: string;
	remoteIndicator: ReactNode;
	action: ReactNode;
}) {
	const working =
		creationPending ||
		attentionState === "running" ||
		(loading && attentionState === "idle");
	const prState = prStateLabelFor(prInfo);

	return (
		<>
			<span className="pointer-events-none relative mt-px size-5 shrink-0">
				<Avatar className="size-5 rounded-[5px] ring-1 ring-white/5">
					{projectAvatarUrl !== null && (
						<AvatarImage src={projectAvatarUrl} alt="" />
					)}
					<AvatarFallback className="rounded-[5px] bg-sidebar-accent">
						<DitherAvatar name={projectName ?? title} size={20} />
					</AvatarFallback>
				</Avatar>
				{working || attentionState !== "idle" ? (
					<span className="absolute -right-1 -bottom-1 grid size-3.5 place-items-center rounded-full bg-sidebar ring-1 ring-sidebar">
						{working ? (
							<span
								aria-hidden="true"
								className="size-2.5 animate-spin rounded-full border-[1.5px] border-foreground/25 border-t-foreground motion-reduce:animate-none"
							/>
						) : (
							<ChatAttentionIcon
								state={attentionState}
								className="size-3.5 [&_svg]:size-2.5"
							/>
						)}
						<span className="sr-only">{statusLabel}</span>
					</span>
				) : null}
			</span>
			<div className="pointer-events-none flex min-w-0 flex-1 flex-col gap-[3px]">
				<div className="flex min-w-0 items-center gap-2">
					<TypewriterText
						text={title}
						className="min-w-0 flex-1 truncate leading-4"
					/>
					<div className="relative flex h-4 shrink-0 items-center">
						{remoteIndicator}
						<span className="text-[11px] font-normal tabular-nums text-muted-foreground/60 group-hover:hidden">
							{time}
						</span>
						{action}
					</div>
				</div>
				<div className="flex h-3.5 min-w-0 items-center gap-1 text-[11px] font-normal text-muted-foreground/60">
					{projectName !== undefined ? (
						<span className="min-w-0 truncate">{projectName}</span>
					) : null}
					{prInfo !== null && prState !== null ? (
						<span className="ml-1 inline-flex min-w-0 shrink-[2] items-center gap-1">
							<PrStateIcon pr={prInfo} className="size-3" />
							{prInfo.number === null ? null : (
								<span className="shrink-0 tabular-nums">#{prInfo.number}</span>
							)}
							<span className="min-w-0 truncate">{prState}</span>
						</span>
					) : null}
					{stats !== null ? (
						<span className="ml-auto shrink-0 pl-2 tabular-nums">
							<span className="text-success/70">
								+{formatCompactNumber(stats.additions)}
							</span>{" "}
							<span className="text-danger-text/70">
								−{formatCompactNumber(stats.deletions)}
							</span>
						</span>
					) : null}
				</div>
			</div>
		</>
	);
}

function ChatArchiveButton({
	icon,
	label,
	chatTitle,
	archiving,
	busy,
	onClick,
}: {
	icon: IconSvgElement;
	label: string;
	chatTitle: string;
	archiving: boolean;
	busy: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={busy}
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			className={cn(
				"pointer-events-auto relative z-10 items-center rounded-md p-0.5 text-muted-foreground transition-opacity duration-150 ease-out hover:text-sidebar-accent-foreground motion-reduce:transition-none",
				archiving ? "flex" : "hidden group-focus-within:flex group-hover:flex",
			)}
			aria-label={`${label} ${chatTitle}`}
			title={label}
		>
			{busy ? (
				<Spinner className="size-3.5" />
			) : (
				<HugeiconsIcon icon={icon} className="size-3.5" />
			)}
		</button>
	);
}

function ChatAttentionIcon({
	state,
	selected = false,
	className,
	context = "chat",
}: {
	state: ChatAttentionState;
	selected?: boolean;
	className?: string;
	context?: "chat" | "project";
}) {
	if (state === "idle") return null;

	const color = selected
		? "text-sidebar-accent-foreground"
		: state === "question" || state === "permission"
			? "text-amber-600 dark:text-amber-300"
			: state === "planReady"
				? "text-emerald-600 dark:text-emerald-300"
				: "text-foreground";
	const label =
		state === "question"
			? context === "project"
				? "A chat is waiting for your answer"
				: "Waiting for your answer"
			: state === "permission"
				? context === "project"
					? "A chat is waiting for permission"
					: "Waiting for permission"
				: state === "planReady"
					? context === "project"
						? "A chat has a plan ready to approve"
						: "Plan ready to approve"
					: context === "project"
						? "Agent is working in a session"
						: "Agent is working";
	const classes = cn(
		"inline-grid size-5 shrink-0 place-items-center",
		color,
		className,
	);

	const executionLabel = executionAttentionLabel(state);
	if (executionLabel !== null || state === "running") {
		return (
			<span className={classes} title={executionLabel ?? label}>
				<AgentActivityOrb
					state="working"
					label={executionLabel ?? label}
					className={
						state === "quiet" || state === "unavailable"
							? "text-warning"
							: "text-muted-foreground"
					}
				/>
			</span>
		);
	}

	return (
		<span className={classes} role="img" aria-label={label} title={label}>
			{state === "question" ? (
				<HugeiconsIcon
					icon={HelpCircleIcon}
					className="size-3.5"
					aria-hidden="true"
				/>
			) : state === "permission" ? (
				<HugeiconsIcon
					icon={SquareLock01Icon}
					className="size-3.5"
					aria-hidden="true"
				/>
			) : (
				<HugeiconsIcon
					icon={TaskDone01Icon}
					className="size-3.5"
					aria-hidden="true"
				/>
			)}
		</span>
	);
}
