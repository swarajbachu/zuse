import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
	Analytics01Icon,
	ArchiveArrowDownIcon,
	ArchiveArrowUpIcon,
	ArchiveIcon,
	ArrowDown01Icon,
	ArrowRight01Icon,
	Delete02Icon,
	Edit01Icon,
	FolderAddIcon,
	HelpCircleIcon,
	Login03Icon,
	Logout01Icon,
	PencilIcon,
	Settings01Icon,
	SquareLock01Icon,
	TaskDone01Icon,
	UserCircleIcon,
} from "@hugeicons-pro/core-solid-rounded";
import type {
	Chat,
	ChatId,
	FolderId,
	GitOriginInfo,
	Session,
	SessionId,
} from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { BlurredEmail } from "~/components/blurred-email";
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
import { cn, formatCompactNumber } from "~/lib/utils";
import { dispatchCommand } from "../lib/commands.ts";
import { noteSessionStatusForCompletionSound } from "../lib/completion-sounds.ts";
import {
	getRpcClient,
	reportRendererRpcStreamFailure,
	subscribeRendererRpcConnection,
} from "../lib/rpc-client.ts";
import { formatShortcut } from "../lib/shortcuts.ts";
import { useArchivePreviewStore } from "../store/archive-preview.ts";
import {
	archiveChatWithConfirm,
	chatArchiveProgressLabel,
	isChatUnread,
	useChatsStore,
} from "../store/chats.ts";
import { gitDiffStatKey, useGitDiffStatStore } from "../store/git-diff-stat.ts";
import { useMessagesStore } from "../store/messages.ts";
import { useRegisterPane } from "../store/pane-focus.ts";
import { usePermissionsStore } from "../store/permissions.ts";
import { prStateKey, usePrStateStore } from "../store/pr-state.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { useUsageLimitsStore } from "../store/usage-limits.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { BranchIcon, type BranchState } from "./branch-icon.tsx";
import { ProjectAddMenu } from "./project-add-menu.tsx";
import { Spinner } from "./ui/spinner";

const sidebarErrorToastCache = {
	chats: null as string | null,
	sessions: null as string | null,
	workspace: null as string | null,
};

const initialsOf = (name: string): string => {
	const parts = name.split(/[-_.\s]+/).filter(Boolean);
	const letters =
		parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : name.slice(0, 2);
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

/** One summary feed per project replaces a transport stream for every row. */
function applySessionSummary(
	projectId: FolderId,
	change:
		| {
				readonly _tag: "snapshot";
				readonly cursor: number;
				readonly sessions: ReadonlyArray<Session>;
		  }
		| {
				readonly _tag: "change";
				readonly sequence: number;
				readonly session: Session;
		  }
		| {
				readonly _tag: "remove";
				readonly sequence: number;
				readonly sessionId: SessionId;
		  },
): void {
	const sessions =
		change._tag === "snapshot"
			? change.sessions
			: change._tag === "change"
				? [change.session]
				: [];
	const previousRunning = useMessagesStore.getState().runningBySession;
	useMessagesStore.getState().observeSessionStatuses(
		sessions.map((session) => ({
			sessionId: session.id,
			status: session.status,
		})),
	);
	for (const session of sessions) {
		const wasRunning = previousRunning[session.id] === true;
		noteSessionStatusForCompletionSound(session.id, session.status);
		if (wasRunning && session.status !== "running") {
			const chats = useChatsStore.getState();
			if (chats.selectedChatId === session.chatId) {
				void chats.markRead(session.chatId);
			} else {
				chats.noteChatActivity(session.chatId);
			}
		}
	}
	useSessionsStore.setState((state) => {
		const current = state.sessionsByProject[projectId] ?? [];
		if (change._tag === "snapshot") {
			const incoming = new Set(change.sessions.map((session) => session.id));
			const unacknowledged = current.filter(
				(session) => session.status === "booting" && !incoming.has(session.id),
			);
			return {
				sessionsByProject: {
					...state.sessionsByProject,
					[projectId]: [...unacknowledged, ...change.sessions],
				},
			};
		}
		if (change._tag === "remove") {
			return {
				sessionsByProject: {
					...state.sessionsByProject,
					[projectId]: current.filter(
						(session) => session.id !== change.sessionId,
					),
				},
			};
		}
		const found = current.some((session) => session.id === change.session.id);
		return {
			sessionsByProject: {
				...state.sessionsByProject,
				[projectId]: found
					? current.map((session) =>
							session.id === change.session.id ? change.session : session,
						)
					: [change.session, ...current],
			},
		};
	});
}

function useProjectSessionSummarySubscriptions(
	projectIds: ReadonlyArray<FolderId>,
) {
	const fibersRef = useRef(new Map<FolderId, Fiber.Fiber<unknown, unknown>>());
	const generationsRef = useRef(new Map<FolderId, number>());
	const cursorsRef = useRef(new Map<FolderId, number>());
	const idsKey = projectIds.join("\u0000");

	useEffect(() => {
		const wanted = new Set(projectIds);
		for (const [projectId, fiber] of fibersRef.current) {
			if (wanted.has(projectId)) continue;
			fibersRef.current.delete(projectId);
			generationsRef.current.delete(projectId);
			cursorsRef.current.delete(projectId);
			void Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {});
		}
		const unsubscribe = subscribeRendererRpcConnection((snapshot) => {
			if (snapshot.status !== "connected") return;
			for (const projectId of projectIds) {
				if (generationsRef.current.get(projectId) === snapshot.generation) {
					continue;
				}
				generationsRef.current.set(projectId, snapshot.generation);
				const previous = fibersRef.current.get(projectId);
				if (previous !== undefined) {
					void Effect.runPromise(Fiber.interrupt(previous)).catch(() => {});
				}
				const generation = snapshot.generation;
				const fiber = Effect.runFork(
					Effect.tryPromise(() => getRpcClient()).pipe(
						Effect.flatMap((client) =>
							Stream.runForEach(
								client["session.streamChanges"]({
									projectId,
									sinceSequence: cursorsRef.current.get(projectId),
								}),
								(change) =>
									Effect.sync(() => {
										const sequence =
											change._tag === "snapshot"
												? change.cursor
												: change.sequence;
										if ((cursorsRef.current.get(projectId) ?? -1) >= sequence) {
											return;
										}
										cursorsRef.current.set(projectId, sequence);
										applySessionSummary(projectId, change);
									}),
							),
						),
						Effect.match({
							onFailure: (cause) => {
								if (generationsRef.current.get(projectId) === generation) {
									reportRendererRpcStreamFailure(generation, cause);
								}
							},
							onSuccess: () => {
								if (generationsRef.current.get(projectId) === generation) {
									reportRendererRpcStreamFailure(
										generation,
										new Error("session summary stream completed unexpectedly"),
									);
								}
							},
						}),
					),
				);
				fibersRef.current.set(projectId, fiber);
			}
		});
		return unsubscribe;
	}, [idsKey]);

	useEffect(
		() => () => {
			for (const fiber of fibersRef.current.values()) {
				void Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {});
			}
			fibersRef.current.clear();
		},
		[],
	);
}

export function ProjectsSidebar() {
	const paneRef = useRef<HTMLElement>(null);
	useRegisterPane("sidebar", paneRef);
	const folders = useWorkspaceStore((s) => s.folders);
	const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
	const loading = useWorkspaceStore((s) => s.loading);
	const load = useWorkspaceStore((s) => s.load);
	const remove = useWorkspaceStore((s) => s.remove);
	const select = useWorkspaceStore((s) => s.select);

	const sessionsByProject = useSessionsStore((s) => s.sessionsByProject);
	const hydrateSessions = useSessionsStore((s) => s.hydrate);

	const chatsByProject = useChatsStore((s) => s.chatsByProject);
	const hydrateChats = useChatsStore((s) => s.hydrate);

	const [origins, setOrigins] = useState<Record<string, GitOriginInfo | null>>(
		{},
	);
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});

	useEffect(() => {
		void load();
	}, [load]);

	// Auto-expand the selected project so newly opened workspaces immediately
	// reveal their session list.
	useEffect(() => {
		if (selectedFolderId === null) return;
		setExpanded((prev) =>
			prev[selectedFolderId] ? prev : { ...prev, [selectedFolderId]: true },
		);
	}, [selectedFolderId]);

	// Lazy-hydrate chats AND sessions for any expanded project that hasn't
	// been loaded. Sidebar reads chats; tab strip reads sessions; both stores
	// are populated up-front so switching projects doesn't show empty tabs.
	useEffect(() => {
		for (const folder of folders) {
			if (!expanded[folder.id]) continue;
			if (!(folder.id in chatsByProject)) void hydrateChats(folder.id);
			if (!(folder.id in sessionsByProject)) void hydrateSessions(folder.id);
		}
	}, [
		expanded,
		folders,
		chatsByProject,
		sessionsByProject,
		hydrateChats,
		hydrateSessions,
	]);

	// Eagerly hydrate the (lightweight) chat list for EVERY project, regardless
	// of expansion. This is what lets read/unread — and the cross-project "Next
	// unread" button — see chats in collapsed/unvisited projects on startup.
	// Sessions stay lazy (above); the live unread signal only needs them for
	// projects the user actually opens.
	useEffect(() => {
		for (const folder of folders) {
			if (!(folder.id in chatsByProject)) void hydrateChats(folder.id);
		}
	}, [folders, chatsByProject, hydrateChats]);

	// PR state is keyed per-session by `(folderId, worktreeId)` because each
	// worktree has its own branch and therefore its own PR. Hydration happens
	// inside `SessionRow` so each row pulls the entry that matches its
	// session — no per-project bulk hydrate.

	// Resolve git origin for avatar rendering. Lookups that fail stay `null`
	// and the row falls back to initials.
	useEffect(() => {
		let cancelled = false;
		const missing = folders.filter((f) => !(f.id in origins));
		if (missing.length === 0) return;
		void (async () => {
			const client = await getRpcClient();
			for (const folder of missing) {
				try {
					const info = await Effect.runPromise(
						client["git.origin"]({ folderId: folder.id }),
					);
					if (cancelled) return;
					setOrigins((prev) => ({ ...prev, [folder.id]: info }));
				} catch {
					if (cancelled) return;
					setOrigins((prev) => ({ ...prev, [folder.id]: null }));
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [folders, origins]);

	useProjectSessionSummarySubscriptions(folders.map((folder) => folder.id));

	const onToggleExpanded = (id: FolderId) =>
		setExpanded((previous) => ({ ...previous, [id]: !previous[id] }));

	return (
		<aside
			ref={paneRef}
			data-pane="sidebar"
			tabIndex={-1}
			className="flex h-full min-h-0 w-full flex-col bg-sidebar text-sidebar-foreground outline-none"
		>
			<SidebarActions />
			<div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground">
				<span>Projects</span>
				<ProjectAddMenu />
			</div>
			<SidebarErrorToasts />

			<ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
				{folders.length === 0 && !loading && (
					<li className="px-3 py-4 text-center text-xs text-muted-foreground">
						No projects yet. Click + to add one.
					</li>
				)}
				{folders.map((folder) => (
					<ProjectGroup
						key={folder.id}
						id={folder.id}
						name={folder.name}
						path={folder.path}
						origin={origins[folder.id] ?? null}
						isExpanded={expanded[folder.id] === true}
						chats={chatsByProject[folder.id] ?? []}
						projectSessions={sessionsByProject[folder.id] ?? []}
						onSelect={() => void select(folder.id)}
						onToggleExpanded={() => onToggleExpanded(folder.id)}
						onRemove={() => void remove(folder.id)}
					/>
				))}
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
		<div className="flex flex-col gap-0.5 border-b border-sidebar-border/40 px-2 pb-2 pt-2">
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
			className="flex min-h-7 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<HugeiconsIcon icon={icon} className="size-4 shrink-0" />
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{shortcut !== undefined && shortcut !== "" ? (
				<kbd className="shrink-0 font-sans text-[11px] text-muted-foreground/60">
					{shortcut}
				</kbd>
			) : null}
		</button>
	);
}

function SidebarFooter() {
	return (
		<div className="flex flex-col gap-0.5 border-t border-sidebar-border/40 px-2 py-1.5">
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
	const loadUsageLimits = useUsageLimitsStore((s) => s.load);

	// Always render an affordance. Until auth state resolves (or whenever signed
	// out) we show "Sign in" — a brief flash to the signed-in row on cold load
	// is fine and far better than showing nothing.
	const initial = (name || user?.email || "?").charAt(0).toUpperCase();
	const nameIsEmail = Boolean(user?.email && name === user.email);

	return (
		<Menu>
			<MenuTrigger
				render={
					<button
						type="button"
						onPointerEnter={() => void loadUsageLimits()}
						onFocus={() => void loadUsageLimits()}
						className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-[11px] text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
					>
						{isSignedIn ? (
							<Avatar className="size-5 text-[9px]">
								{user?.profilePictureUrl ? (
									<AvatarImage src={user.profilePictureUrl} alt={name} />
								) : null}
								<AvatarFallback className="text-[9px]">
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

function ProjectGroup({
	id,
	name,
	path,
	origin,
	isExpanded,
	chats,
	projectSessions,
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
	}>;
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
		void useArchivePreviewStore.getState().showList(id);
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

	const visibleChats = useMemo(
		() => chats.filter((c) => c.archivedAt === null),
		[chats],
	);

	// Surface the highest-priority attention hint on the collapsed project
	// header when any session inside this project needs attention.
	const liveSessionIds = useMemo(
		() => projectSessions.filter((s) => s.archivedAt === null).map((s) => s.id),
		[projectSessions],
	);
	const headerRunning = useMessagesStore((s) =>
		mergeChatAttentionStates(
			liveSessionIds.map((id) =>
				s.runningBySession[id] === true ? "running" : "idle",
			),
		),
	);
	const headerMessageAttention = useMessagesStore((s) =>
		mergeChatAttentionStates(
			liveSessionIds.map((id) =>
				deriveChatAttentionState(s.messagesBySession[id] ?? [], false),
			),
		),
	);
	const liveSessionIdSet = useMemo(
		() => new Set(liveSessionIds),
		[liveSessionIds],
	);
	// Pending permission prompts never become messages, so they bypass
	// `headerMessageAttention`. Pull them straight from the permissions store.
	const headerPermissionAttention = usePermissionsStore((s) =>
		derivePermissionAttention(Object.values(s.requestsById), liveSessionIdSet),
	);
	const headerAttention = mergeChatAttentionStates([
		headerRunning,
		headerMessageAttention,
		headerPermissionAttention,
	]);
	const showHeaderAttention = headerAttention !== "idle" && !isExpanded;

	const chevron = isExpanded ? ArrowDown01Icon : ArrowRight01Icon;

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
					className="group flex cursor-pointer items-center gap-2 px-3 py-2.5 transition-colors hover:bg-sidebar-accent/30 rounded-md"
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
							<AvatarFallback className="rounded text-[9px]">
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
						<HugeiconsIcon
							icon={chevron}
							aria-hidden="true"
							className={cn(
								"col-start-1 row-start-1 size-3.5 text-muted-foreground opacity-0 transition-opacity duration-150 ease-out",
								"group-hover:opacity-100 motion-reduce:transition-none",
							)}
						/>
					</div>
					<span
						className="min-w-0 flex-1 truncate text-sm"
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
					{visibleChats.length === 0 && (
						<li className="px-12 py-1 text-[11px] text-muted-foreground">
							No chats yet.
						</li>
					)}
					{visibleChats.map((chat) => (
						<ChatRow key={chat.id} chat={chat} />
					))}
				</ul>
			</li>
		</Fragment>
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
					className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-sidebar-accent"
				>
					<HugeiconsIcon icon={Settings01Icon} className="size-3.5" />
					Settings
				</MenuItem>
				<MenuItem
					onClick={onOpenArchives}
					className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-sidebar-accent"
				>
					<HugeiconsIcon icon={ArchiveIcon} className="size-3.5" />
					Archived chats
				</MenuItem>
				<MenuItem
					onClick={onOpenUsage}
					className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-sidebar-accent"
				>
					<HugeiconsIcon icon={Analytics01Icon} className="size-3.5" />
					Usage
				</MenuItem>
				<MenuItem
					onClick={onRemove}
					className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-red-300 hover:bg-red-500/20"
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
		createNewSession(projectId);
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

function ChatRow({ chat }: { chat: Chat }) {
	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
	const selectedChatId = useChatsStore((s) => s.selectedChatId);
	const sessionsByProject = useSessionsStore((s) => s.sessionsByProject);

	const selectChat = useChatsStore((s) => s.select);
	const renameChat = useChatsStore((s) => s.rename);
	const unarchiveChat = useChatsStore((s) => s.unarchive);
	const removeChat = useChatsStore((s) => s.remove);
	const archiveProgress = useChatsStore(
		(s) => s.archiveProgressByChat[chat.id] ?? null,
	);

	// PR state is keyed by (project, worktree). A chat owns its worktree,
	// so all its sessions share the same PR row — hydrate once per chat.
	const prInfo = usePrStateStore(
		(s) => s.byKey[prStateKey(chat.projectId, chat.worktreeId)] ?? null,
	);
	const hydratePrState = usePrStateStore((s) => s.hydrate);
	useEffect(() => {
		void hydratePrState(chat.projectId, chat.worktreeId);
	}, [hydratePrState, chat.projectId, chat.worktreeId]);

	// Per-branch diff stats (additions/deletions vs base), shown even when no
	// PR exists yet — so a working branch surfaces its size in the sidebar.
	const diffStat = useGitDiffStatStore(
		(s) => s.byKey[gitDiffStatKey(chat.projectId, chat.worktreeId)] ?? null,
	);
	const hydrateDiffStat = useGitDiffStatStore((s) => s.hydrate);
	useEffect(() => {
		void hydrateDiffStat(chat.projectId, chat.worktreeId);
	}, [hydrateDiffStat, chat.projectId, chat.worktreeId]);

	// Ids of this chat's non-archived sessions — so the sidebar busy
	// indicator reflects ANY tab being active, not just the currently
	// selected one.
	const sessionIds = useMemo(
		() =>
			(sessionsByProject[chat.projectId] ?? [])
				.filter((row) => row.chatId === chat.id && row.archivedAt === null)
				.map((row) => row.id),
		[sessionsByProject, chat.projectId, chat.id],
	);

	const runningAttention = useMessagesStore((s) =>
		mergeChatAttentionStates(
			sessionIds.map((id) =>
				s.runningBySession[id] === true ? "running" : "idle",
			),
		),
	);
	const messageAttention = useMessagesStore((s) =>
		mergeChatAttentionStates(
			sessionIds.map((id) =>
				deriveChatAttentionState(s.messagesBySession[id] ?? [], false),
			),
		),
	);
	const sessionIdSet = useMemo(() => new Set(sessionIds), [sessionIds]);
	// Supervised-mode permission prompts live only in the permissions store —
	// they never arrive as messages, so they'd otherwise leave the row dark.
	const permissionAttention = usePermissionsStore((s) =>
		derivePermissionAttention(Object.values(s.requestsById), sessionIdSet),
	);
	const attentionState = mergeChatAttentionStates([
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

	const branchState: BranchState = isArchived
		? "archived"
		: prInfo === null || prInfo.state === "none"
			? "default"
			: prInfo.state === "merged"
				? "pr-merged"
				: prInfo.state === "closed"
					? "pr-closed"
					: // open PR — reflect CI / conflict status
						prInfo.checks === "failure" || prInfo.mergeable === "conflicting"
						? "pr-failing"
						: prInfo.checks === "pending"
							? "pr-pending"
							: "pr-open";

	// Prefer the live branch diff (works without a PR); fall back to the PR's
	// own counts so merged/closed branches still show their size.
	const stats =
		diffStat !== null && (diffStat.additions > 0 || diffStat.deletions > 0)
			? diffStat
			: prInfo !== null && (prInfo.additions > 0 || prInfo.deletions > 0)
				? { additions: prInfo.additions, deletions: prInfo.deletions }
				: null;
	const showDiff = stats !== null;

	const onRename = () => {
		const next = window.prompt("Rename chat", chat.title);
		if (next === null) return;
		const trimmed = next.trim();
		if (trimmed.length === 0 || trimmed === chat.title) return;
		void renameChat(chat.id, trimmed);
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
						"group flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-xs transition-colors",
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
					title={chat.title}
				>
					{attentionState !== "idle" ? (
						<ChatAttentionIcon
							state={attentionState}
							selected={isSelected}
							className="ml-3"
						/>
					) : (
						<BranchIcon
							state={branchState}
							selected={isSelected}
							className="ml-3"
						/>
					)}
					<TypewriterText
						text={chat.title}
						className="min-w-0 flex-1 truncate"
					/>
					<div className="relative flex h-4 w-16 shrink-0 items-center justify-end">
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
						className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-sidebar-accent"
					>
						<HugeiconsIcon icon={PencilIcon} className="size-3.5" />
						Rename
					</MenuItem>
					{isArchived ? (
						<MenuItem
							onClick={() => void unarchiveChat(chat.id)}
							className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-sidebar-accent"
						>
							<HugeiconsIcon icon={ArchiveArrowUpIcon} className="size-3.5" />
							Unarchive
						</MenuItem>
					) : (
						<MenuItem
							disabled={isArchiving}
							onClick={archiveChat}
							className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-sidebar-accent"
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
						className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-red-300 hover:bg-red-500/20"
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

	return (
		<span
			role="img"
			className={cn(
				"inline-flex size-3.5 shrink-0 items-center justify-center",
				color,
				className,
			)}
			aria-label={label}
			title={label}
		>
			{state === "running" ? (
				<Spinner className="size-4" />
			) : state === "question" ? (
				<HugeiconsIcon icon={HelpCircleIcon} className="size-3.5" />
			) : state === "permission" ? (
				<HugeiconsIcon icon={SquareLock01Icon} className="size-3.5" />
			) : (
				<HugeiconsIcon icon={TaskDone01Icon} className="size-3.5" />
			)}
		</span>
	);
}
