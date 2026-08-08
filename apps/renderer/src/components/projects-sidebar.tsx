import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
	Analytics01Icon,
	ArchiveArrowDownIcon,
	ArchiveArrowUpIcon,
	ArchiveIcon,
	ArrowDown01Icon,
	ArrowRight01Icon,
	ComputerIcon,
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
	SessionStatus,
} from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
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
import { isHostedProduct, signOutHostedProduct } from "~/lib/hosted-connect.ts";
import { cn, formatCompactNumber } from "~/lib/utils";
import { dispatchCommand } from "../lib/commands.ts";
import { noteSessionRuntimeCompletion } from "../lib/completion-sounds.ts";
import { branchStateFor, diffStatsFor } from "../lib/pr-branch-state.ts";
import {
	buildLogicalProjectGroups,
	type LogicalChatRef,
	type LogicalProjectGroup,
	preferredGroupMember,
} from "../lib/project-groups.ts";
import {
	getLocalEnvironmentId,
	getRpcClient,
	reportRendererRpcStreamFailure,
	subscribeRendererRpcConnection,
} from "../lib/rpc-client.ts";
import {
	effectiveSessionRuntimeState,
	isSessionRuntimeBusy,
} from "../lib/session-runtime-state.ts";
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
import { useFolderOriginsStore } from "../store/folder-origins.ts";
import { gitDiffStatKey, useGitDiffStatStore } from "../store/git-diff-stat.ts";
import { useMessagesStore } from "../store/messages.ts";
import { useRegisterPane } from "../store/pane-focus.ts";
import { usePermissionsStore } from "../store/permissions.ts";
import { prStateKey, usePrStateStore } from "../store/pr-state.ts";
import {
	subscribeSessionTerminals,
	useSessionRuntimeStore,
} from "../store/session-runtime.ts";
import { getSessionById, useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { useUsageLimitsStore } from "../store/usage-limits.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { openAddComputerDialog } from "./add-computer-dialog.tsx";
import { BranchIcon, type BranchState } from "./branch-icon.tsx";
import { ProjectAddMenu } from "./project-add-menu.tsx";
import { AgentActivityOrb } from "./ui/agent-activity-orb.tsx";
import { Spinner } from "./ui/spinner";

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
	if (change._tag === "remove") {
		useSessionRuntimeStore.getState().remove(change.sessionId);
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
	environmentId: string,
) {
	const fibersRef = useRef(new Map<FolderId, Fiber.Fiber<unknown, unknown>>());
	const generationsRef = useRef(new Map<FolderId, number>());
	const cursorsRef = useRef(new Map<FolderId, number>());
	const idsKey = `${environmentId}\u0001${projectIds.join("\u0000")}`;

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
					Effect.tryPromise(() => getRpcClient(environmentId)).pipe(
						Effect.flatMap((client) =>
							Stream.runForEach(
								client["session.streamChanges"]({
									projectId,
								}),
								(change) =>
									Effect.sync(() => {
										const sequence =
											change._tag === "snapshot"
												? change.cursor
												: change.sequence;
										if (change._tag === "snapshot") {
											cursorsRef.current.set(
												projectId,
												Math.max(
													cursorsRef.current.get(projectId) ?? -1,
													sequence,
												),
											);
											applySessionSummary(projectId, change);
											return;
										}
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
									reportRendererRpcStreamFailure(
										generation,
										cause,
										environmentId,
									);
								}
							},
							onSuccess: () => {
								if (generationsRef.current.get(projectId) === generation) {
									reportRendererRpcStreamFailure(
										generation,
										new Error("session summary stream completed unexpectedly"),
										environmentId,
									);
								}
							},
						}),
					),
				);
				fibersRef.current.set(projectId, fiber);
			}
		}, environmentId);
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

function useSessionRuntimeEffects(): void {
	useEffect(
		() =>
			subscribeSessionTerminals((sessionId) => {
				noteSessionRuntimeCompletion();
				const session = getSessionById(sessionId);
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
	const load = useWorkspaceStore((s) => s.load);
	const remove = useWorkspaceStore((s) => s.remove);
	const select = useWorkspaceStore((s) => s.select);
	const catalogEntries = useEnvironmentCatalogStore((s) => s.entries);
	const activeEnvironmentId = useEnvironmentCatalogStore(
		(s) => s.activeEnvironmentId,
	);

	const sessionsByProject = useSessionsStore((s) => s.sessionsByProject);

	const chatsByProject = useChatsStore((s) => s.chatsByProject);
	const hydrateChats = useChatsStore((s) => s.hydrate);

	const origins = useFolderOriginsStore((s) => s.byFolder);
	const hydrateOrigins = useFolderOriginsStore((s) => s.hydrate);
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});

	useEffect(() => {
		void load();
	}, [load]);

	// Auto-expand the selected project so newly opened workspaces immediately
	// reveal their session list.
	useEffect(() => {
		if (selectedFolderId === null) return;
		const key = environmentProjectKey(activeEnvironmentId, selectedFolderId);
		setExpanded((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
	}, [activeEnvironmentId, selectedFolderId]);

	// Chat streams hydrate expanded projects. Session summary streams below own
	// their snapshot and live continuation, so a second list request is unnecessary.
	useEffect(() => {
		for (const folder of folders) {
			if (!expanded[environmentProjectKey(activeEnvironmentId, folder.id)])
				continue;
			if (!(folder.id in chatsByProject)) void hydrateChats(folder.id);
		}
	}, [activeEnvironmentId, expanded, folders, chatsByProject, hydrateChats]);

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

	// Resolve git origin for avatar rendering + logical grouping. Lookups that
	// fail stay `null` and the row falls back to initials.
	useEffect(() => {
		void hydrateOrigins(folders.map((folder) => folder.id));
	}, [folders, hydrateOrigins]);

	useProjectSessionSummarySubscriptions(
		folders.map((folder) => folder.id),
		activeEnvironmentId,
	);

	const onToggleKey = (key: string) => {
		setExpanded((previous) => ({ ...previous, [key]: !previous[key] }));
	};
	const onToggleExpanded = (environmentId: string, id: FolderId) => {
		onToggleKey(environmentProjectKey(environmentId, id));
	};

	const desktopCatalogEnabled = window.zuse?.ssh !== undefined;

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
					})
				: [],
		[
			desktopCatalogEnabled,
			catalogEntries,
			activeEnvironmentId,
			folders,
			origins,
			chatsByProject,
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
			<div className="flex items-center justify-between px-2.5 py-1.5 text-[11px] text-muted-foreground">
				<span>{desktopCatalogEnabled ? "Computers" : "Projects"}</span>
				{desktopCatalogEnabled ? (
					<Suspense fallback={<span className="size-8" />}>
						<ComputerSwitcher />
					</Suspense>
				) : (
					<ProjectAddMenu />
				)}
			</div>
			{desktopCatalogEnabled ? (
				<CatalogConnectionNotice entries={catalogEntries} />
			) : null}
			<SidebarErrorToasts />

			<ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
				{desktopCatalogEnabled ? (
					<>
						{logicalGroups.length === 0 && !loading ? (
							<li className="px-3 py-4 text-center text-xs text-muted-foreground">
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
							<li className="px-3 py-4 text-center text-xs text-muted-foreground">
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
			className="flex min-h-6 w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
	const loadUsageLimits = useUsageLimitsStore((s) => s.load);

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
							className="flex min-h-7 w-full items-center gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground outline-none hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
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
						className="min-h-9 rounded-lg px-2.5 text-xs"
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
						className="mx-1.5 flex min-h-6 items-center gap-1.5 rounded-md px-2 text-left text-[11px] text-muted-foreground/80 outline-none hover:bg-sidebar-accent/40 hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
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
	const chevron = isExpanded ? ArrowDown01Icon : ArrowRight01Icon;
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
								<AvatarFallback className="rounded text-[9px]">
									{initialsOf(group.origin?.owner ?? group.displayName)}
								</AvatarFallback>
							</Avatar>
							<HugeiconsIcon
								aria-hidden="true"
								icon={chevron}
								className="col-start-1 row-start-1 size-3.5 text-muted-foreground opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 motion-reduce:transition-none"
							/>
						</span>
						<span className="min-w-0 flex-1 truncate text-[11px]">
							{group.displayName}
						</span>
					</button>
					{group.environmentPresence === "remote-only" ? (
						<Tooltip>
							<TooltipTrigger
								render={
									<span className="inline-flex shrink-0 text-muted-foreground/70">
										<HugeiconsIcon
											icon={ComputerIcon}
											aria-hidden
											className="size-3"
										/>
										<span className="sr-only">On {memberLabels}</span>
									</span>
								}
							/>
							<TooltipPopup>On {memberLabels}</TooltipPopup>
						</Tooltip>
					) : null}
					{preferred?.connected ? (
						<button
							type="button"
							aria-label={`New chat in ${group.displayName}`}
							className="rounded-md p-1 text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
							onClick={() =>
								void switchToEnvironment({
									environmentId: preferred.environmentId,
									folderId: preferred.folderId,
								})
							}
						>
							<HugeiconsIcon icon={Edit01Icon} className="size-3.5" />
						</button>
					) : null}
				</div>
			</li>
			<li id={listId} className="list-none" hidden={!isExpanded}>
				<ul aria-label={`${group.displayName} chats`}>
					{rows.length === 0 ? (
						<li className="px-12 py-1 text-[11px] text-muted-foreground">
							No chats yet.
						</li>
					) : null}
					{rows.map((row) => (
						<CatalogChatRow
							key={`${row.ref.environmentId}:${row.ref.chat.id}`}
							chatRef={row.ref}
							connected={row.connected}
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
}: {
	chatRef: LogicalChatRef;
	connected: boolean;
}) {
	const { chat, environmentId, environmentLabel, remote, busy } = chatRef;
	const isArchived = chat.archivedAt !== null;
	const prInfo = usePrStateStore(
		(s) =>
			s.byKey[prStateKey(environmentId, chat.projectId, chat.worktreeId)] ??
			null,
	);
	const hydratePrState = usePrStateStore((s) => s.hydrate);
	const diffStat = useGitDiffStatStore(
		(s) =>
			s.byKey[gitDiffStatKey(environmentId, chat.projectId, chat.worktreeId)] ??
			null,
	);
	const hydrateDiffStat = useGitDiffStatStore((s) => s.hydrate);
	useEffect(() => {
		// Only reachable computers get asked — never hammer an offline env.
		if (!connected) return;
		void hydratePrState(environmentId, chat.projectId, chat.worktreeId);
		void hydrateDiffStat(environmentId, chat.projectId, chat.worktreeId);
	}, [
		connected,
		environmentId,
		chat.projectId,
		chat.worktreeId,
		hydratePrState,
		hydrateDiffStat,
	]);
	const stats = diffStatsFor(diffStat, prInfo);
	return (
		<li>
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
				title={chat.title}
				className={cn(
					"group flex min-h-6 w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
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
						<Tooltip>
							<TooltipTrigger
								render={
									<span className="mr-1 inline-flex text-muted-foreground/70">
										<HugeiconsIcon
											icon={ComputerIcon}
											aria-hidden
											className="size-3"
										/>
										<span className="sr-only">On {environmentLabel}</span>
									</span>
								}
							/>
							<TooltipPopup>On {environmentLabel}</TooltipPopup>
						</Tooltip>
					) : null}
					<span className="tabular-nums text-[10px] text-muted-foreground">
						{stats !== null ? (
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
				</div>
			</button>
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
		return [...local, ...remote].sort(
			(left, right) => right.updatedAt - left.updatedAt,
		);
	}, [visibleChats, remoteChats]);

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
	const headerRunning = useSessionRuntimeStore((s) =>
		mergeChatAttentionStates(
			liveSessions.map((session) =>
				isSessionRuntimeBusy(
					effectiveSessionRuntimeState(s.bySession[session.id]),
				)
					? "running"
					: "idle",
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
						className="min-w-0 flex-1 truncate text-[11px]"
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
						<li className="px-12 py-1 text-[11px] text-muted-foreground">
							No chats yet.
						</li>
					)}
					{chatRows.map((entry) =>
						entry.kind === "local" ? (
							<ChatRow key={entry.chat.id} chat={entry.chat} />
						) : (
							<CatalogChatRow
								key={`${entry.row.ref.environmentId}:${entry.row.ref.chat.id}`}
								chatRef={entry.row.ref}
								connected={entry.row.connected}
							/>
						),
					)}
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

	// PR state is keyed by (environment, project, worktree). A chat owns its
	// worktree, so all its sessions share the same PR row — hydrate once per
	// chat.
	const prInfo = usePrStateStore(
		(s) =>
			s.byKey[
				prStateKey(activeEnvironmentId, chat.projectId, chat.worktreeId)
			] ?? null,
	);
	const hydratePrState = usePrStateStore((s) => s.hydrate);
	useEffect(() => {
		if (creationPending) return;
		void hydratePrState(activeEnvironmentId, chat.projectId, chat.worktreeId);
	}, [
		creationPending,
		hydratePrState,
		activeEnvironmentId,
		chat.projectId,
		chat.worktreeId,
	]);

	// Per-branch diff stats (additions/deletions vs base), shown even when no
	// PR exists yet — so a working branch surfaces its size in the sidebar.
	const diffStat = useGitDiffStatStore(
		(s) =>
			s.byKey[
				gitDiffStatKey(activeEnvironmentId, chat.projectId, chat.worktreeId)
			] ?? null,
	);
	const hydrateDiffStat = useGitDiffStatStore((s) => s.hydrate);
	useEffect(() => {
		if (creationPending) return;
		void hydrateDiffStat(activeEnvironmentId, chat.projectId, chat.worktreeId);
	}, [
		creationPending,
		hydrateDiffStat,
		activeEnvironmentId,
		chat.projectId,
		chat.worktreeId,
	]);

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

	const runningAttention = useSessionRuntimeStore((s) =>
		mergeChatAttentionStates(
			chatSessions.map((session) =>
				isSessionRuntimeBusy(
					effectiveSessionRuntimeState(s.bySession[session.id]),
				)
					? "running"
					: "idle",
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
						"group flex min-h-6 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors",
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
							<Tooltip>
								<TooltipTrigger
									render={
										<span className="mr-1 inline-flex text-muted-foreground/70 group-hover:hidden">
											<HugeiconsIcon
												icon={ComputerIcon}
												aria-hidden
												className="size-3"
											/>
											<span className="sr-only">On {environmentLabel}</span>
										</span>
									}
								/>
								<TooltipPopup>On {environmentLabel}</TooltipPopup>
							</Tooltip>
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
