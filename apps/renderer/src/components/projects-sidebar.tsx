import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
	type Chat,
	type ChatId,
	type CloudChatSummary,
	EnvironmentId,
	type FolderId,
	type GitOriginInfo,
	type ProviderId,
	type SessionId,
	type SessionStatus,
} from "@zuse/contracts";
import {
	Analytics01Icon,
	ArchiveArrowDownIcon,
	ArchiveArrowUpIcon,
	ArchiveIcon,
	CloudIcon,
	Delete02Icon,
	Edit01Icon,
	Folder01Icon,
	FolderAddIcon,
	GitBranchIcon,
	HelpCircleIcon,
	Login03Icon,
	Logout01Icon,
	PencilIcon,
	ServerStack01Icon,
	Settings01Icon,
	SquareLock01Icon,
	TaskDone01Icon,
	UserCircleIcon,
} from "@zuse/icons/solid-rounded";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
	Fragment,
	lazy,
	Suspense,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { BlurredEmail } from "~/components/blurred-email.tsx";
import { TypewriterText } from "~/components/typewriter-text.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuShortcut,
	MenuTrigger,
} from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { UsageLimitsMenuItems } from "~/components/usage/usage-limits-submenu";
import { useAuth } from "~/hooks/use-auth.ts";
import {
	type ChatAttentionState,
	deriveChatAttentionState,
	derivePermissionAttention,
	mergeChatAttentionStates,
} from "~/lib/chat-attention-state";
import { displayPath } from "~/lib/display-path";
import { activeSessionById } from "~/lib/environment-entities.ts";
import { useActiveEnvironmentEntities } from "~/lib/environment-entity-hooks.ts";
import { useEnvironmentPermissions } from "~/lib/environment-permissions-client-bus.ts";
import { formatError } from "~/lib/format-error.ts";
import { isHostedProduct, signOutHostedProduct } from "~/lib/hosted-connect.ts";
import { cn, formatCompactNumber } from "~/lib/utils";
import { deriveCloudChatActivity } from "../lib/cloud-chat-activity.ts";
import { cloudChatRowPresentation } from "../lib/cloud-chat-row-presentation.ts";
import { cloudWorkspaceBetaAvailable } from "../lib/cloud-machines-availability.ts";
import { useCloudChatCatalogStore } from "../lib/cloud-workspace-catalog.ts";
import {
	openCloudChat,
	repositoryIdentityForOrigin,
	useCloudChatsStore,
} from "../lib/cloud-workspaces.ts";
import { dispatchCommand } from "../lib/commands.ts";
import { noteSessionRuntimeCompletion } from "../lib/completion-sounds.ts";
import {
	useEnvironmentShellCatalog,
	useEnvironmentShellResource,
} from "../lib/environment-shell-client-bus.ts";
import { useGitWorkspaceResource } from "../lib/git-workspace-client-bus.ts";
import { openNewChatLanding } from "../lib/open-new-chat-landing.ts";
import { branchStateFor, diffStatsFor } from "../lib/pr-branch-state.ts";
import {
	buildLogicalProjectGroups,
	type LogicalChatRef,
	type LogicalProjectGroup,
	preferredGroupMember,
} from "../lib/project-groups.ts";
import { getLocalEnvironmentId } from "../lib/rpc-client.ts";
import { isSessionRuntimeBusy } from "../lib/session-runtime-state.ts";
import {
	useRendererSessionTimeline,
	useRendererSessionTimelines,
} from "../lib/session-timeline-hooks.ts";
import { formatShortcut } from "../lib/shortcuts.ts";
import { switchToEnvironment } from "../lib/switch-environment.ts";
import { useArchivePreviewStore } from "../store/archive-preview.ts";
import {
	archiveChatWithConfirm,
	chatArchiveProgressLabel,
	isChatUnread,
	useChatsStore,
} from "../store/chats.ts";
import {
	type EnvironmentCatalogEntry,
	useEnvironmentCatalogStore,
} from "../store/environment-catalog.ts";
import { useRegisterPane } from "../store/pane-focus.ts";
import { subscribeSessionTerminals } from "../store/session-runtime.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { useUsageLimitsStore } from "../store/usage-limits.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { EMPTY_WORKTREES, useWorktreesStore } from "../store/worktrees.ts";
import { openAddComputerDialog } from "./add-computer-dialog.tsx";
import { BranchIcon, type BranchState } from "./branch-icon.tsx";
import { ProjectAddMenu } from "./project-add-menu.tsx";
import { ProviderIcon } from "./provider-icons.tsx";
import { AgentActivityOrb } from "./ui/agent-activity-orb.tsx";
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

// GitHub serves owner/org avatars at this path; works for users and orgs alike.
// Returns null for non-GitHub remotes so the caller falls back to initials.
const avatarUrlFor = (origin: GitOriginInfo | null): string | null => {
	if (origin === null || origin.host !== "github.com") return null;
	return `https://github.com/${encodeURIComponent(origin.owner)}.png?size=80`;
};

const formatRelative = (iso: Date): string => {
	const ms = Date.now() - iso.getTime();
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return "just now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	return `${day}d ago`;
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
	useSessionRuntimeEffects();
	const paneRef = useRef<HTMLElement>(null);
	useRegisterPane("sidebar", paneRef);
	const folders = useWorkspaceStore((s) => s.folders);
	const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
	const loading = useWorkspaceStore((s) => s.loading);
	const remove = useWorkspaceStore((s) => s.remove);
	const select = useWorkspaceStore((s) => s.select);
	const catalogEntries = useEnvironmentCatalogStore((s) => s.entries);
	const activeEnvironmentId = useEnvironmentCatalogStore(
		(s) => s.activeEnvironmentId,
	);
	const shellViews = useEnvironmentShellCatalog(
		catalogEntries.map((entry) => entry.environmentId),
	);
	const initializeEnvironmentCatalog = useEnvironmentCatalogStore(
		(s) => s.initialize,
	);

	const {
		chatsByProject,
		originsByFolder: origins,
		sessionsByProject,
	} = useActiveEnvironmentEntities();
	const storedCloudChats = useCloudChatCatalogStore((s) => s.summaries);
	const cloudChats = CLOUD_WORKSPACE_BETA_AVAILABLE
		? storedCloudChats
		: EMPTY_CLOUD_CHATS;
	const hydrateCloudChats = useCloudChatsStore((s) => s.hydrate);

	const [expanded, setExpanded] = useState<Record<string, boolean>>({});

	useEffect(() => {
		if (CLOUD_WORKSPACE_BETA_AVAILABLE) void hydrateCloudChats();
	}, [hydrateCloudChats]);

	const desktopCatalogEnabled = window.zuse?.ssh !== undefined;

	useEffect(() => {
		void initializeEnvironmentCatalog().catch((cause) =>
			console.error("[zuse] environment catalog initialize failed", cause),
		);
	}, [initializeEnvironmentCatalog]);

	// Auto-expand the selected project so newly opened workspaces immediately
	// reveal their session list.
	useEffect(() => {
		if (selectedFolderId === null) return;
		const key = environmentProjectKey(activeEnvironmentId, selectedFolderId);
		setExpanded((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
	}, [activeEnvironmentId, selectedFolderId]);

	// PR state is keyed per-session by `(folderId, worktreeId)` because each
	// worktree has its own branch and therefore its own PR. Hydration happens
	// inside `SessionRow` so each row pulls the entry that matches its
	// session — no per-project bulk hydrate.

	const onToggleKey = (key: string) => {
		setExpanded((previous) => ({ ...previous, [key]: !previous[key] }));
	};
	const onToggleExpanded = (environmentId: string, id: FolderId) => {
		onToggleKey(environmentProjectKey(environmentId, id));
	};

	const showComputerControls =
		desktopCatalogEnabled &&
		catalogEntries.filter((entry) => entry.status === "connected").length > 1;

	// One merged timeline: computers never form sections. The same repo across
	// machines collapses into one logical group; the computer is a row property.
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
		],
	);

	return (
		<aside
			ref={paneRef}
			data-pane="sidebar"
			tabIndex={-1}
			className="flex h-full min-h-0 w-full flex-col bg-sidebar text-sidebar-foreground outline-none"
		>
			{desktopCatalogEnabled ? null : (
				<Suspense
					fallback={
						<div className="h-[60px] border-b border-sidebar-border/40" />
					}
				>
					<ComputerSwitcher />
				</Suspense>
			)}
			<SidebarActions />
			{showComputerControls ? (
				<div className="flex items-center justify-between px-2.5 py-1.5 text-[12px] text-muted-foreground">
					<span>Computers</span>
					<Suspense fallback={<span className="size-8" />}>
						<ComputerSwitcher />
					</Suspense>
				</div>
			) : null}
			<div className="flex items-center justify-between px-2.5 py-1.5 text-[12px] text-muted-foreground">
				<span>Projects</span>
				<ProjectAddMenu />
			</div>
			{showComputerControls ? (
				<CatalogConnectionNotice entries={catalogEntries} />
			) : null}
			<SidebarErrorToasts />

			<ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
				{desktopCatalogEnabled ? (
					<>
						{logicalGroups.length === 0 && !loading ? (
							<li className="px-3 py-4 text-center text-[13px] text-muted-foreground">
								No projects yet. Click + to add one.
							</li>
						) : null}
						{logicalGroups.map((group) => {
							const activeMember = group.members.find(
								(member) => member.isActive,
							);
							const folder =
								activeMember === undefined
									? undefined
									: folders.find((f) => f.id === activeMember.folderId);
							if (activeMember !== undefined && folder !== undefined) {
								return (
									<ProjectGroup
										key={group.key}
										id={folder.id}
										name={folder.name}
										path={folder.path}
										origin={origins[folder.id] ?? null}
										isExpanded={
											expanded[
												environmentProjectKey(activeEnvironmentId, folder.id)
											] === true
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
										onSelect={() => void select(folder.id)}
										onToggleExpanded={() =>
											onToggleExpanded(activeEnvironmentId, folder.id)
										}
										onRemove={() => void remove(folder.id)}
									/>
								);
							}
							return (
								<LogicalCatalogGroup
									key={group.key}
									group={group}
									isExpanded={expanded[group.key] === true}
									onToggle={() => onToggleKey(group.key)}
								/>
							);
						})}
					</>
				) : (
					<>
						{folders.length === 0 && !loading ? (
							<li className="px-3 py-4 text-center text-[13px] text-muted-foreground">
								No projects yet. Click + to add one.
							</li>
						) : null}
						{folders.map((folder) => (
							<ProjectGroup
								key={folder.id}
								id={folder.id}
								name={folder.name}
								path={folder.path}
								origin={origins[folder.id] ?? null}
								isExpanded={
									expanded[
										environmentProjectKey(activeEnvironmentId, folder.id)
									] === true
								}
								chats={chatsByProject[folder.id] ?? []}
								projectSessions={sessionsByProject[folder.id] ?? []}
								cloudChats={cloudChats.filter(
									(chat) =>
										chat.repositoryIdentity ===
										repositoryIdentityForOrigin(origins[folder.id]),
								)}
								environmentId={EnvironmentId.make(activeEnvironmentId)}
								onSelect={() => void select(folder.id)}
								onToggleExpanded={() =>
									onToggleExpanded(activeEnvironmentId, folder.id)
								}
								onRemove={() => void remove(folder.id)}
							/>
						))}
					</>
				)}
			</ul>
			<SidebarFooter />
		</aside>
	);
}

/**
 * Quick actions pinned at the top of the sidebar — the two things you reach
 * for constantly (start a chat, add a project) as plain rows instead of
 * hunting for the small + icons.
 */
function SidebarActions() {
	return (
		<div className="flex flex-col gap-0.5 border-b border-sidebar-border/40 px-1.5 py-1.5">
			<SidebarActionRow
				icon={Edit01Icon}
				label="New chat"
				shortcut={formatShortcut("new-chat")}
				onClick={() => dispatchCommand("new-chat")}
			/>
			<SidebarActionRow
				icon={FolderAddIcon}
				label="New project"
				onClick={() => dispatchCommand("open-project")}
			/>
		</div>
	);
}

function SidebarActionRow({
	icon,
	label,
	shortcut,
	onClick,
}: {
	icon: IconSvgElement;
	label: string;
	shortcut?: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex min-h-6 w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-left text-[12px] text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<HugeiconsIcon icon={icon} className="size-4 shrink-0" />
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{shortcut !== undefined && shortcut !== "" ? (
				<kbd className="shrink-0 font-sans text-[12px] text-muted-foreground/60">
					{shortcut}
				</kbd>
			) : null}
		</button>
	);
}

function SidebarFooter() {
	return (
		<div className="flex flex-col gap-0.5 border-t border-sidebar-border/40 px-1.5 py-1">
			<SidebarAccount />
		</div>
	);
}

/**
 * Bottom-of-sidebar account control. Signed out → a "Sign in" button. Signed
 * in → avatar + name that opens a menu (Account settings, Sign out). Auth is
 * optional, so this is the primary place to discover sign-in after onboarding.
 */
function SidebarAccount() {
	const { isSignedIn, user, name, signingIn, signIn, signOut } = useAuth();
	const setView = useUiStore((s) => s.setView);
	const setSettingsSection = useUiStore((s) => s.setSettingsSection);
	const refreshUsageLimits = useUsageLimitsStore((s) => s.refresh);

	// Always render an affordance. Until auth state resolves (or whenever signed
	// out) we show "Sign in" — a brief flash to the signed-in row on cold load
	// is fine and far better than showing nothing.
	const initial = (name || user?.email || "?").charAt(0).toUpperCase();
	const nameIsEmail = Boolean(user?.email && name === user.email);
	if (isHostedProduct()) {
		return (
			<Menu>
				<MenuTrigger
					render={
						<button
							type="button"
							className="flex min-h-7 w-full items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground outline-none hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
						>
							<HugeiconsIcon icon={UserCircleIcon} className="size-4" />
							<span className="min-w-0 flex-1 truncate text-left">
								Zuse account
							</span>
						</button>
					}
				/>
				<MenuPopup
					side="top"
					align="start"
					sideOffset={6}
					className="w-(--anchor-width) rounded-xl"
				>
					<MenuItem
						variant="destructive"
						onClick={() => void signOutHostedProduct()}
						className="min-h-9 rounded-lg px-2.5 text-[13px]"
					>
						<HugeiconsIcon icon={Logout01Icon} />
						Sign out of this browser
					</MenuItem>
				</MenuPopup>
			</Menu>
		);
	}

	return (
		<Menu>
			<MenuTrigger
				render={
					<button
						type="button"
						onPointerEnter={() => {
							// Force-refresh so Kiro OIDC misses cannot stick in the
							// soft 60s cache (token is short-lived).
							void refreshUsageLimits(true);
						}}
						onFocus={() => {
							void refreshUsageLimits(true);
						}}
						className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-[12px] text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
					>
						{isSignedIn ? (
							<Avatar className="size-5 text-[10px]">
								{user?.profilePictureUrl ? (
									<AvatarImage src={user.profilePictureUrl} alt={name} />
								) : null}
								<AvatarFallback className="text-[10px]">
									{initial}
								</AvatarFallback>
							</Avatar>
						) : (
							<HugeiconsIcon icon={Login03Icon} className="size-3.5" />
						)}
						{!isSignedIn ? (
							<span>{signingIn ? "Signing in…" : "Sign in"}</span>
						) : nameIsEmail && user?.email ? (
							<BlurredEmail email={user.email} />
						) : (
							<span className="min-w-0 flex-1 truncate text-left">{name}</span>
						)}
					</button>
				}
			/>
			<MenuPopup side="top" align="start" className="w-64">
				{!isSignedIn ? (
					<>
						<MenuItem disabled={signingIn} onClick={() => void signIn()}>
							<HugeiconsIcon icon={Login03Icon} />
							Sign in
						</MenuItem>
						<MenuSeparator />
					</>
				) : (
					<MenuItem
						onClick={() => {
							setSettingsSection({ kind: "general" });
							setView("settings");
						}}
					>
						<HugeiconsIcon icon={UserCircleIcon} />
						Account settings
					</MenuItem>
				)}
				<UsageLimitsMenuItems />
				<MenuItem onClick={() => setView("settings")}>
					<HugeiconsIcon icon={Settings01Icon} />
					Settings<MenuShortcut>{formatShortcut("settings")}</MenuShortcut>
				</MenuItem>
				{isSignedIn ? (
					<>
						<MenuSeparator />
						<MenuItem variant="destructive" onClick={() => void signOut()}>
							<HugeiconsIcon icon={Logout01Icon} />
							Sign out
						</MenuItem>
					</>
				) : null}
			</MenuPopup>
		</Menu>
	);
}

/** A remote chat row plus whether its computer is currently reachable. */
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
	// Data-source split: everything NOT from the active environment's live
	// stores renders as a catalog row. The remote BADGE is `ref.remote`,
	// which is anchored to this physical desktop instead.
	return group.chats
		.filter((ref) => !ref.live)
		.map((ref) => ({
			ref,
			connected: connectedEnvironments.has(ref.environmentId),
		}));
};

/**
 * Connection problems no longer occupy sidebar blocks — one quiet line under
 * the "Computers" strip carries them, with the details in a tooltip and a
 * click-through to the connect dialog.
 */
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
}: {
	readonly title: string;
	readonly repository: string;
	readonly location: string;
	readonly branch?: string | null;
	readonly providerId?: ProviderId | null;
	readonly model?: string | null;
	readonly status: string;
}) {
	return (
		<div className="min-w-48 max-w-72 space-y-1 px-1 py-0.5 text-[12px]">
			<div className="mb-1.5 truncate text-[13px] font-medium text-foreground">
				{title || "New chat"}
			</div>
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
			<div className="pt-0.5 text-[11px] text-muted-foreground/80">
				{status}
			</div>
		</div>
	);
}

/**
 * A logical project group with no folder on the active environment: a light
 * header (avatar ↔ chevron swap, same anatomy as the full `ProjectGroup`)
 * over `CatalogChatRow`s. Clicking a chat switches to its computer.
 */
function LogicalCatalogGroup({
	group,
	isExpanded,
	onToggle,
}: {
	group: LogicalProjectGroup;
	isExpanded: boolean;
	onToggle: () => void;
}) {
	const preferred = preferredGroupMember(group);
	const rows = remoteChatRows(group);
	const Chevron = isExpanded ? ChevronDown : ChevronRight;
	const avatarUrl = avatarUrlFor(group.origin);
	const listId = `catalog-project-${group.key.replace(/[^\w-]/gu, "-")}`;
	const memberLabels = group.members
		.map((member) => member.environmentLabel)
		.join(", ");

	return (
		<Fragment>
			<li>
				<div className="group flex min-h-7 items-center gap-1.5 rounded-md px-2 transition-colors hover:bg-sidebar-accent/30 motion-reduce:transition-none">
					<button
						type="button"
						aria-expanded={isExpanded}
						aria-controls={listId}
						className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
						onClick={onToggle}
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
							aria-label={`New chat in ${group.displayName}`}
							className="rounded-md p-1 text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
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
			</li>
			<li id={listId} className="list-none" hidden={!isExpanded}>
				<ul aria-label={`${group.displayName} chats`}>
					{rows.length === 0 ? (
						<li className="px-12 py-1 text-[12px] text-muted-foreground">
							No chats yet.
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
			</li>
		</Fragment>
	);
}

/**
 * A chat rendered from the environment catalog (any computer that is not the
 * ACTIVE environment), mirroring `ChatRow`'s anatomy — including the branch
 * icon and `+N −N` diff stats, fetched from the chat's own computer. The
 * muted computer icon marks rows on a different physical machine than this
 * desktop. Clicking switches the whole app to that chat's environment.
 */
function CatalogChatRow({
	chatRef,
	connected,
	repositoryName,
}: {
	chatRef: LogicalChatRef;
	connected: boolean;
	repositoryName: string;
}) {
	const { chat, environmentId, environmentLabel, remote, busy } = chatRef;
	const isArchived = chat.archivedAt !== null;
	// Sidebar discovery is cache-only and must never wake a remote environment.
	// Runtime Git state is retained only after selecting the environment, so a
	// catalog placeholder uses its monotonic metadata and relative activity.
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
								"group flex min-h-6 w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
								connected
									? "cursor-pointer hover:bg-sidebar-accent/40"
									: "cursor-default opacity-60",
							)}
						>
							<span className="ml-3 inline-grid size-5 shrink-0 place-items-center">
								{busy ? (
									<>
										<span
											aria-hidden="true"
											className="size-1.5 rounded-full bg-emerald-500"
										/>
										<span className="sr-only">Agent running</span>
									</>
								) : (
									<BranchIcon
										state={branchStateFor(prInfo, isArchived)}
										selected={false}
									/>
								)}
							</span>
							<span className="min-w-0 flex-1 truncate">
								{chat.title || "New chat"}
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
									{formatRelative(chat.updatedAt)}
								</span>
							</div>
						</button>
					}
				/>
				<TooltipPopup side="right" align="start" sideOffset={8}>
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
	/** Same-repo chats on other computers, interleaved into the chat list. */
	remoteChats?: ReadonlyArray<RemoteChatRow>;
	/** Durable cloud chats remain visible independently of sandbox state. */
	cloudChats?: ReadonlyArray<CloudChatSummary>;
	environmentId: EnvironmentId;
	onSelect: () => void;
	onToggleExpanded: () => void;
	onRemove: () => void;
}) {
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
	const [menuOpen, setMenuOpen] = useState(false);
	const anchorRef = useRef<{ getBoundingClientRect: () => DOMRect } | null>(
		null,
	);

	const openRepositorySettings = () => {
		setSettingsSection({ kind: "repository", projectId: id });
		setView("settings");
	};

	const openArchives = () => {
		onSelect();
		void useArchivePreviewStore.getState().showList(environmentId, id);
		setView("chat");
		setActiveMainTab("archives");
	};

	const openProjectUsage = () => {
		onSelect();
		openUsage("project");
	};

	const onContextMenu = (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		const rect = new DOMRect(e.clientX, e.clientY, 0, 0);
		anchorRef.current = { getBoundingClientRect: () => rect };
		setMenuOpen(true);
	};

	const visibleChats = useMemo(() => {
		const cloudIds = new Set((cloudChats ?? []).map((row) => row.chatId));
		return chats.filter(
			(chat) =>
				chat.archivedAt === null &&
				!cloudIds.has(chat.id) &&
				!hiddenArchivedChatIds.has(chat.id),
		);
	}, [chats, cloudChats, hiddenArchivedChatIds]);

	// One merged timeline inside the group: local chats and same-repo chats on
	// other computers interleave by recency instead of forming sections.
	const chatRows = useMemo(() => {
		const local = visibleChats.map((chat) => ({
			kind: "local" as const,
			chat,
			updatedAt: chat.updatedAt.getTime(),
		}));
		const remote = (remoteChats ?? []).map((row) => ({
			kind: "remote" as const,
			row,
			updatedAt: row.ref.chat.updatedAt.getTime(),
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
				updatedAt: summary.lastMessageAt ?? summary.createdAt,
			}));
		return [...local, ...remote, ...cloud].sort(
			(left, right) => right.updatedAt - left.updatedAt,
		);
	}, [visibleChats, remoteChats, cloudChats, hiddenArchivedChatIds]);

	// Surface the highest-priority attention hint on the collapsed project
	// header when any session inside this project needs attention.
	const liveSessions = useMemo(
		() => projectSessions.filter((session) => session.archivedAt === null),
		[projectSessions],
	);
	const liveSessionIds = useMemo(
		() => liveSessions.map((session) => session.id),
		[liveSessions],
	);
	const liveTimelineRefs = useMemo(
		() => liveSessionIds.map((sessionId) => ({ environmentId, sessionId })),
		[environmentId, liveSessionIds],
	);
	const liveTimelines = useRendererSessionTimelines(
		liveTimelineRefs,
		"cache-only",
	);
	const headerRunning = useMemo(
		() =>
			mergeChatAttentionStates(
				liveTimelines.map((timeline) =>
					isSessionRuntimeBusy(timeline.runtime) ? "running" : "idle",
				),
			),
		[liveTimelines],
	);
	const headerMessageAttention = useMemo(
		() =>
			mergeChatAttentionStates(
				liveTimelines.map((timeline) =>
					deriveChatAttentionState(timeline.messages, false),
				),
			),
		[liveTimelines],
	);
	const liveSessionIdSet = useMemo(
		() => new Set(liveSessionIds),
		[liveSessionIds],
	);
	// Pending permission prompts never become messages, so they bypass
	// `headerMessageAttention`. Pull them straight from the permissions store.
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

	const Chevron = isExpanded ? ChevronDown : ChevronRight;

	return (
		<Fragment>
			{/* Project header toggles expansion only. Explicit actions below select
          the project when they need project context. */}
			<li>
				{/* biome-ignore lint/a11y/useSemanticElements: this row contains nested action buttons. */}
				<div
					role="button"
					tabIndex={0}
					onContextMenu={onContextMenu}
					onClick={() => {
						onToggleExpanded();
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							onToggleExpanded();
						}
					}}
					className="group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors hover:bg-sidebar-accent/30"
				>
					{/* Single 20px slot holds avatar (idle) and chevron (hover). Both
              live in the same grid cell so the row never reflows; opacity
              fades between them. motion-reduce drops the transition. */}
					<div className="relative grid size-5 shrink-0 place-items-center">
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
						className="min-w-0 flex-1 truncate text-[12px]"
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
									className="rounded-md p-0.5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
									aria-label={`Settings for ${displayName}`}
								>
									<HugeiconsIcon icon={Settings01Icon} className="size-3.5" />
								</button>
							}
						/>
						<TooltipPopup>Repository settings</TooltipPopup>
					</Tooltip>
					<NewChatButton projectId={id} />
				</div>

				<ProjectContextMenu
					open={menuOpen}
					anchor={anchorRef.current}
					onOpenSettings={openRepositorySettings}
					onOpenArchives={openArchives}
					onOpenUsage={openProjectUsage}
					onRemove={onRemove}
					onOpenChange={setMenuOpen}
				/>
			</li>

			<li className="list-none" hidden={!isExpanded}>
				<ul aria-label={`${displayName} chats`}>
					{chatRows.length === 0 && (
						<li className="px-12 py-1 text-[12px] text-muted-foreground">
							No chats yet.
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
			</li>
		</Fragment>
	);
}

function CloudChatRow({
	summary,
	projectId,
}: {
	readonly summary: CloudChatSummary;
	readonly projectId: FolderId;
}) {
	const selectedChatId = useChatsStore((state) => state.selectedChatId);
	const archive = useCloudChatsStore((state) => state.archive);
	const [archiving, setArchiving] = useState(false);
	const timeline = useRendererSessionTimeline(
		summary.initialSessionId,
		"cache-only",
		EnvironmentId.make(summary.workspaceId),
	);
	const shell = useEnvironmentShellResource(
		EnvironmentId.make(summary.workspaceId),
		"cache-only",
	);
	const activity = deriveCloudChatActivity({
		summary,
		connection: shell.connection,
		runtime: timeline.runtime,
	});
	const presentation = cloudChatRowPresentation(summary, activity);
	const label = presentation.label;
	const archivePending =
		summary.desiredState === "archived" && summary.state !== "failed";
	const cloudWorkspaceLoading = presentation.busy;
	const providerTone =
		activity === "failed"
			? "text-destructive"
			: activity === "paused"
				? "text-muted-foreground/45"
				: activity === "idle" ||
						activity === "running" ||
						activity === "starting-agent" ||
						activity === "stopping"
					? "text-emerald-500"
					: "text-amber-400";
	const selected = selectedChatId === summary.chatId;
	const open = () => {
		void openCloudChat(summary, projectId).catch((cause) =>
			toastManager.add({
				type: "error",
				title: "Cloud chat could not refresh",
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
					title: "Cloud chat could not be archived",
					description: formatError(cause),
				}),
			)
			.finally(() => setArchiving(false));
	};
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
							aria-busy={cloudWorkspaceLoading || undefined}
							className={cn(
								"group flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent/40 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
								selected && "bg-sidebar-accent text-sidebar-accent-foreground",
							)}
							onClick={open}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									open();
								}
							}}
						>
							<span className="ml-3 inline-grid size-5 shrink-0 place-items-center">
								<BranchIcon state="default" selected={selected} />
							</span>
							<span className="min-w-0 flex-1 truncate">{summary.title}</span>
							<div className="flex h-4 w-16 shrink-0 items-center justify-end gap-1">
								<button
									type="button"
									disabled={archiving || archivePending}
									onClick={(event) => {
										event.stopPropagation();
										archiveChat();
									}}
									className="hidden rounded-md p-0.5 text-muted-foreground hover:text-sidebar-accent-foreground group-hover:flex group-focus-within:flex"
									aria-label={`${summary.state === "failed" && summary.desiredState === "archived" ? "Retry archiving" : "Archive"} ${summary.title}`}
									title={
										summary.state === "failed" &&
										summary.desiredState === "archived"
											? "Retry archive"
											: "Archive"
									}
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
								<span
									className={cn("inline-flex shrink-0", providerTone)}
									role="img"
									aria-label={label}
								>
									<HugeiconsIcon icon={CloudIcon} className="size-3.5" />
								</span>
							</div>
						</div>
					}
				/>
				<TooltipPopup side="right" align="start" sideOffset={8}>
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

function ProjectContextMenu({
	open,
	anchor,
	onOpenSettings,
	onOpenArchives,
	onOpenUsage,
	onRemove,
	onOpenChange,
}: {
	open: boolean;
	anchor: { getBoundingClientRect: () => DOMRect } | null;
	onOpenSettings: () => void;
	onOpenArchives: () => void;
	onOpenUsage: () => void;
	onRemove: () => void;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Menu open={open} onOpenChange={onOpenChange}>
			<MenuPopup
				anchor={anchor ?? undefined}
				align="start"
				side="bottom"
				className="min-w-[180px]"
			>
				<MenuItem
					onClick={onOpenSettings}
					className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-sidebar-accent"
				>
					<HugeiconsIcon icon={Settings01Icon} className="size-3.5" />
					Settings
				</MenuItem>
				<MenuItem
					onClick={onOpenArchives}
					className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-sidebar-accent"
				>
					<HugeiconsIcon icon={ArchiveIcon} className="size-3.5" />
					Archived chats
				</MenuItem>
				<MenuItem
					onClick={onOpenUsage}
					className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-sidebar-accent"
				>
					<HugeiconsIcon icon={Analytics01Icon} className="size-3.5" />
					Usage
				</MenuItem>
				<MenuItem
					onClick={onRemove}
					className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-red-300 hover:bg-red-500/20"
				>
					<HugeiconsIcon icon={Delete02Icon} className="size-3.5" />
					Remove project
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
	// The landing lives on the chat tab. Return there before clearing the
	// selection so creating a chat from Usage or Archives is immediately
	// visible instead of leaving that takeover surface mounted.
	useUiStore.getState().setActiveMainTab("chat");
	// Select the project first (synchronous: `workspace.select` sets
	// `selectedFolderId` before awaiting persistence), then clear the chat +
	// session selection for it. `chats.select(null)` cascades into
	// `sessions.select(null)`, so both the tab strip and the chat surface fall
	// back to the empty landing for this project.
	if (useWorkspaceStore.getState().selectedFolderId !== projectId) {
		void useWorkspaceStore.getState().select(projectId);
	}
	useChatsStore.getState().select(null);
}

function NewChatButton({ projectId }: { projectId: FolderId }) {
	const onClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		openNewChatLanding(projectId);
	};

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={onClick}
						className="rounded-md p-0.5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
						aria-label="New chat"
					>
						<HugeiconsIcon icon={Edit01Icon} className="size-3.5" />
					</button>
				}
			/>
			<TooltipPopup>
				<TooltipShortcut
					label="New chat"
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

function ChatRow({ chat, projectRoot }: { chat: Chat; projectRoot: string }) {
	const { sessionsByProject } = useActiveEnvironmentEntities();
	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
	const selectedChatId = useChatsStore((s) => s.selectedChatId);

	const selectChat = useChatsStore((s) => s.select);
	const renameChat = useChatsStore((s) => s.rename);
	const unarchiveChat = useChatsStore((s) => s.unarchive);
	const removeChat = useChatsStore((s) => s.remove);
	const archiveProgress = useChatsStore(
		(s) => s.archiveProgressByChat[chat.id] ?? null,
	);
	const creationPending = useChatsStore(
		(s) => s.pendingCreationByChat[chat.id] !== undefined,
	);

	// Live rows always belong to the ACTIVE environment; the row is "remote"
	// when that environment is not this physical desktop.
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

	// Ids of this chat's non-archived sessions — so the sidebar busy
	// indicator reflects ANY tab being active, not just the currently
	// selected one.
	const chatSessions = useMemo(
		() =>
			(sessionsByProject[chat.projectId] ?? []).filter(
				(row) => row.chatId === chat.id && row.archivedAt === null,
			),
		[sessionsByProject, chat.projectId, chat.id],
	);
	const sessionIds = useMemo(
		() => chatSessions.map((session) => session.id),
		[chatSessions],
	);
	const timelineRefs = useMemo(
		() =>
			sessionIds.map((sessionId) => ({
				environmentId: EnvironmentId.make(activeEnvironmentId),
				sessionId,
			})),
		[activeEnvironmentId, sessionIds],
	);
	const timelines = useRendererSessionTimelines(timelineRefs, "cache-only");
	const runningAttention = useMemo(
		() =>
			mergeChatAttentionStates(
				timelines.map((timeline) =>
					isSessionRuntimeBusy(timeline.runtime) ? "running" : "idle",
				),
			),
		[timelines],
	);
	const messageAttention = useMemo(
		() =>
			mergeChatAttentionStates(
				timelines.map((timeline) =>
					deriveChatAttentionState(timeline.messages, false),
				),
			),
		[timelines],
	);
	const sessionIdSet = useMemo(() => new Set(sessionIds), [sessionIds]);
	// Supervised-mode permission prompts live only in the permissions store —
	// they never arrive as messages, so they'd otherwise leave the row dark.
	const permissionRequests =
		useEnvironmentPermissions().data?.requestsById ?? {};
	const permissionAttention = derivePermissionAttention(
		Object.values(permissionRequests),
		sessionIdSet,
	);
	const attentionState = mergeChatAttentionStates([
		creationPending ? "running" : "idle",
		runningAttention,
		messageAttention,
		permissionAttention,
	]);

	// Highlight this row when its own chat is selected, OR when the active
	// session (any tab inside this chat) lives in it. Covers the transient
	// window where `selectedChatId` hasn't caught up to `selectedSessionId`.
	const sessionBelongsToChat = useMemo(() => {
		if (selectedSessionId === null) return false;
		return sessionIds.includes(selectedSessionId);
	}, [selectedSessionId, sessionIds]);
	const isSelected = selectedChatId === chat.id || sessionBelongsToChat;
	const isArchived = chat.archivedAt !== null;
	// Unread = new activity the user hasn't seen. A pending permission prompt
	// also counts: the agent is blocked on the user even though no new message
	// landed to advance `lastMessageAt`. Never on the selected row.
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

	return (
		<>
			{renameOpen ? (
				<Suspense fallback={null}>
					<RenameDialog
						title="Rename chat"
						description="Change the name shown in the projects sidebar."
						label="Chat name"
						value={chat.title}
						open
						onOpenChange={setRenameOpen}
						onRename={(title) => renameChat(chat.id, title)}
					/>
				</Suspense>
			) : null}
			<li>
				{/* biome-ignore lint/a11y/useSemanticElements: this row contains a nested archive action. */}
				<div
					role="button"
					tabIndex={0}
					onClick={() => selectChat(chat.id)}
					onContextMenu={onContextMenu}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							selectChat(chat.id);
						}
					}}
					className={cn(
						"group flex min-h-7 cursor-pointer items-center gap-1.5 rounded-md py-1.5 pr-2 pl-1 text-[12px] transition-colors",
						isSelected && "bg-sidebar-accent text-sidebar-accent-foreground",
						!isSelected &&
							isArchived &&
							"text-muted-foreground hover:bg-sidebar-accent/40",
						// Read rows sit dim; unread rows brighten + bold so new activity pops.
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
							? `${chat.title}\nRuns on ${environmentLabel}`
							: chat.title
					}
				>
					<span className="ml-3 inline-grid size-5 shrink-0 place-items-center">
						{attentionState !== "idle" ? (
							<ChatAttentionIcon state={attentionState} selected={isSelected} />
						) : (
							<BranchIcon state={branchState} selected={isSelected} />
						)}
					</span>
					<TypewriterText
						text={chat.title}
						className="min-w-0 flex-1 truncate"
					/>
					<div className="relative flex h-4 w-16 shrink-0 items-center justify-end">
						{onRemoteEnvironment ? (
							<RemoteComputerIndicator
								label={environmentLabel}
								className="mr-1"
								tooltip={false}
							/>
						) : null}
						<span className="tabular-nums text-[10px] text-muted-foreground transition-opacity duration-150 ease-out motion-reduce:transition-none group-hover:hidden">
							{showDiff && stats !== null ? (
								<>
									<span className="text-success">
										+{formatCompactNumber(stats.additions)}
									</span>{" "}
									<span className="text-destructive">
										−{formatCompactNumber(stats.deletions)}
									</span>
								</>
							) : (
								formatRelative(chat.updatedAt)
							)}
						</span>
						<button
							type="button"
							disabled={isArchiving}
							onClick={(e) => {
								e.stopPropagation();
								if (isArchived) {
									void unarchiveChat(chat.id);
								} else {
									archiveChat();
								}
							}}
							className={cn(
								"items-center rounded-md p-0.5 text-muted-foreground transition-opacity duration-150 ease-out hover:text-sidebar-accent-foreground motion-reduce:transition-none",
								isArchiving ? "flex" : "hidden group-hover:flex",
							)}
							aria-label={`${primaryActionLabel} ${chat.title}`}
							title={primaryActionLabel}
						>
							{isArchiving ? (
								<Spinner className="size-3.5" />
							) : (
								<HugeiconsIcon icon={primaryActionIcon} className="size-3.5" />
							)}
						</button>
					</div>
				</div>
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
						Rename
					</MenuItem>
					{isArchived ? (
						<MenuItem
							onClick={() => void unarchiveChat(chat.id)}
							className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-sidebar-accent"
						>
							<HugeiconsIcon icon={ArchiveArrowUpIcon} className="size-3.5" />
							Unarchive
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
							{archiveProgressText ?? "Archive"}
						</MenuItem>
					)}
					<MenuItem
						onClick={onDelete}
						className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-red-300 hover:bg-red-500/20"
					>
						<HugeiconsIcon icon={Delete02Icon} className="size-3.5" />
						Delete
					</MenuItem>
				</MenuPopup>
			</Menu>
		</>
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
			? "text-amber-300"
			: state === "planReady"
				? "text-emerald-300"
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

	if (state === "running") {
		return (
			<span className={classes} title={label}>
				<AgentActivityOrb state="working" label={label} />
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
