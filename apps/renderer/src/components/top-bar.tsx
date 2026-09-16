import { useGitPrState } from "../lib/use-git-pr-state.ts";
import { GitStackMenu } from "./git-stack-menu.tsx";
import "@zuse/i18n/english/projects";
import { isInputComposing } from "../lib/input-composition.ts";
import { CreateBranchDialog } from "./create-branch-dialog.tsx";
import "@zuse/i18n/english/chat";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ChatRef, ExecutionRef } from "@zuse/client-runtime/resource-ref";
import {
	CommandId,
	ComposerInput,
	EnvironmentId,
	type FolderId,
	type GitBranchInfo,
	type GitFailingChecksArtifact,
	type GitMergeMethod,
	type WorktreeId,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	Alert01Icon,
	ArchiveArrowDownIcon,
	ArrowDown01Icon,
	Copy01Icon,
	GitBranchIcon,
	GitMergeIcon,
	GitPullRequestIcon,
	LinkSquare01Icon,
	Loading02Icon,
	MagicWand01Icon,
	Menu01Icon,
	PanelLeftCloseIcon,
	PanelLeftOpenIcon,
	PanelRightCloseIcon,
	PanelRightOpenIcon,
	PencilEdit01Icon,
	PlayIcon,
	Search01Icon,
	Tick01Icon,
	Upload01Icon,
	Wrench01Icon,
} from "@zuse/icons/solid-rounded";
import { ChevronDown, ChevronRight, PanelBottom } from "lucide-react";
import {
	type CSSProperties,
	lazy,
	type ReactNode,
	Suspense,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	canCreatePrFromSyncedBranch,
	deriveBranchWorkflow,
	type OpenPrWorkflow,
	resolveBranchLabel,
} from "../lib/branch-workflow.ts";
import type { OpenTarget } from "../lib/bridge.ts";
import { cloudTopBarContext } from "../lib/cloud-top-bar-context.ts";
import {
	cloudSummaryForChat,
	useCloudChatCatalogStore,
} from "../lib/cloud-workspace-catalog.ts";
import { useActiveEnvironmentEntities } from "../lib/environment-entity-hooks.ts";
import {
	dispatchGitWorkspaceCommand,
	refreshGitWorkspace,
	useGitWorkspaceResource,
} from "../lib/git-workspace-client-bus.ts";
import { isMacHost } from "../lib/host-platform.ts";
import { rendererPlatformCapabilities } from "../lib/platform-capabilities.ts";
import { openTerminalCommand } from "../lib/run-terminal.ts";
import { sendSessionMessage } from "../lib/session-actions.ts";
import { formatShortcut } from "../lib/shortcuts.ts";
import { useActiveContext } from "../store/active-workspace.ts";
import {
	archiveChatWithConfirm,
	chatArchiveProgressLabel,
	useChatsStore,
} from "../store/chats.ts";
import { useMergePrefs } from "../store/merge-prefs.ts";
import {
	repositorySettingsKey,
	useRepositorySettingsStore,
} from "../store/repository-settings.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { rightPaneKey, useUiStore } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { useWorktreesStore } from "../store/worktrees.ts";
import {
	CloudWorkspaceOpenSshMenu,
	useIsCloudWorkspace,
} from "./cloud-workspace-info.tsx";
import {
	GlassActionButton,
	GlassChip,
	type GlassTone,
} from "./glass-action.tsx";
import { OpenTargetIcon } from "./open-target-icon.tsx";
import { TooltipShortcut } from "./projects-sidebar.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar.tsx";
import { ErrorBoundary } from "./ui/error-boundary.tsx";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuShortcut,
	MenuTrigger,
} from "./ui/menu.tsx";
import { toastManager } from "./ui/toast.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

const loadRenameDialog = () => import("./rename-dialog.tsx");
const RenameDialog = lazy(() =>
	loadRenameDialog().then((module) => ({ default: module.RenameDialog })),
);

/**
 * Open a URL in the user's real browser via the desktop bridge, falling back
 * to `window.open` when running outside Electron (Storybook / web preview).
 * Mirrors `pr-pane.tsx`'s helper.
 */
const openExternal = (url: string): void => {
	const bridge = window.zuse?.app;
	if (bridge !== undefined) {
		bridge.openExternal(url);
		return;
	}
	window.open(url, "_blank", "noopener,noreferrer");
};

const SECTION_CLASS =
	"flex h-10 shrink-0 items-center gap-1 border-b border-border text-[11px] [-webkit-app-region:drag]";
const ACTION_CLASS = "[-webkit-app-region:no-drag]";
const ICON_BUTTON_CLASS = `${ACTION_CLASS} flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground`;
const NATIVE_CONTROLS_INSET_CLASS =
	"pr-[calc(var(--zuse-window-controls-right-inset)+0.25rem)]";

const executionRefFor = (
	context: ReturnType<typeof useActiveContext>,
): ExecutionRef | null =>
	context.status === "ready"
		? {
				environmentId: context.environmentId,
				folderId: context.folderId,
				worktreeId: context.worktreeId,
				rootPath: context.rootPath,
			}
		: null;

/**
 * Top bar over the projects panel: product name on the left + a left-pane
 * collapse toggle on the right. In windowed mode we leave 80px clear at
 * the start so the macOS traffic-light controls have room; in fullscreen
 * the controls are gone, so we hug the edge instead.
 */
export function TopBarLeft() {
	const { message: uiMessage } = useUiMessages(["chat", "projects", "common"]);

	const setLeftSidebarOpen = useUiStore((s) => s.setLeftSidebarOpen);
	const isFullScreen = useUiStore((s) => s.isFullScreen);
	const reserveMacTrafficLights = isMacHost() && !isFullScreen;

	return (
		<section
			aria-label={uiMessage("common:projects_controls")}
			className="shrink-0"
		>
			<div
				role="toolbar"
				aria-label={uiMessage("common:projects_toolbar")}
				className={`${SECTION_CLASS} pr-1 ${reserveMacTrafficLights ? "pl-20" : "pl-3"}`}
			>
				<span className="truncate font-semibold tracking-tight text-foreground">
					{uiMessage("chat:top_bar_zuse_beta")}
				</span>
				<span className="flex-1" />
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								type="button"
								onClick={() => setLeftSidebarOpen(false)}
								className={ICON_BUTTON_CLASS}
								aria-label={uiMessage("chat:top_bar_hide_projects_panel")}
							>
								<HugeiconsIcon icon={PanelLeftCloseIcon} className="size-3.5" />
							</button>
						}
					/>
					<TooltipPopup>
						<TooltipShortcut
							label={uiMessage("common:hide_projects_panel")}
							shortcut={formatShortcut("toggle-left-sidebar")}
						/>
					</TooltipPopup>
				</Tooltip>
			</div>
		</section>
	);
}

/**
 * Top bar over the main pane. Holds the projects-panel open-toggle (only
 * when that panel is collapsed), the branch label, and the right-pane
 * open/close toggle (always visible — the user expects to find it here
 * regardless of which way the files panel is currently leaning).
 */
export function TopBarMain() {
	const { message: uiMessage } = useUiMessages(["chat", "projects", "common"]);

	// Pull folderId + worktreeId from the canonical active context so the
	// branch label can never disagree with the terminal cwd, file tree root,
	// or composer chip — they all read from the same hook.
	const ctx = useActiveContext();
	const executionRef = executionRefFor(ctx);
	const environmentId =
		executionRef?.environmentId ??
		(ctx.status === "worktree-pending"
			? ctx.environmentId
			: ctx.status === "cloud-unavailable"
				? EnvironmentId.make(ctx.workspaceId)
				: null);
	const folderId =
		ctx.status === "ready" || ctx.status === "worktree-pending"
			? ctx.folderId
			: null;
	const worktreeId =
		ctx.status === "ready" || ctx.status === "worktree-pending"
			? ctx.worktreeId
			: null;
	const status =
		useGitWorkspaceResource(executionRef, "connect").data?.status ?? null;
	const refreshWorktrees = useWorktreesStore((s) => s.refresh);
	const leftSidebarOpen = useUiStore((s) => s.leftSidebarOpen);
	const setLeftSidebarOpen = useUiStore((s) => s.setLeftSidebarOpen);
	const selectedChatId = useChatsStore((s) => s.selectedChatId);
	const selectedChatRef: ChatRef | null =
		selectedChatId === null || environmentId === null
			? null
			: { environmentId, chatId: selectedChatId };
	const selectedChatKey =
		selectedChatRef === null ? null : rightPaneKey(selectedChatRef);
	const registeredCloudSummaryCandidate =
		selectedChatId === null ? null : cloudSummaryForChat(selectedChatId);
	const registeredCloudSummary =
		registeredCloudSummaryCandidate?.workspaceId ===
		selectedChatRef?.environmentId
			? registeredCloudSummaryCandidate
			: null;
	const cloudSummary = useCloudChatCatalogStore((state) =>
		selectedChatRef === null
			? null
			: (state.summaries.find(
					(item) =>
						item.chatId === selectedChatRef.chatId &&
						item.workspaceId === selectedChatRef.environmentId,
				) ?? registeredCloudSummary),
	);
	const cachedCloudContext = cloudTopBarContext(cloudSummary);
	const rightSidebarOpen = useUiStore((s) =>
		selectedChatKey === null
			? false
			: (s.rightPaneLayoutByChat[selectedChatKey]?.open ?? false),
	);
	const setRightSidebarOpenForChat = useUiStore(
		(s) => s.setRightSidebarOpenForChat,
	);
	const bottomTerminalOpen = useUiStore((s) =>
		selectedChatKey === null
			? false
			: (s.bottomTerminalLayoutByChat[selectedChatKey]?.open ?? false),
	);
	const setBottomTerminalOpenForChat = useUiStore(
		(s) => s.setBottomTerminalOpenForChat,
	);
	const isFullScreen = useUiStore((s) => s.isFullScreen);
	const environmentSummaryOpen = useUiStore((s) => s.environmentSummaryOpen);
	const toggleEnvironmentSummary = useUiStore(
		(s) => s.toggleEnvironmentSummary,
	);
	// On the empty new-chat landing (no session yet) we hide the repo/branch
	// label + open-in menu so the surface reads as a clean blank chat. The
	// sidebar toggle buttons stay.
	const hasSession = useSessionsStore((s) => s.selectedSessionId !== null);
	const isCloudWorkspace = useIsCloudWorkspace(
		ctx.status === "ready" ? ctx.environmentId : null,
	);
	const folder = useWorkspaceStore((s) =>
		folderId ? (s.folders.find((f) => f.id === folderId) ?? null) : null,
	);
	const origin = useActiveEnvironmentEntities().originsByFolder[folderId ?? ""];
	const originLabel =
		origin !== null && origin !== undefined
			? `${origin.owner}/${origin.repo}`
			: null;
	const [branches, setBranches] = useState<ReadonlyArray<GitBranchInfo>>([]);
	const [branchesLoading, setBranchesLoading] = useState(false);
	const [branchError, setBranchError] = useState<string | null>(null);
	const [renameOpen, setRenameOpen] = useState(false);
	const projectedWorktreeBranch = useWorktreesStore((state) =>
		folderId === null || worktreeId === null
			? null
			: ((state.byProject[folderId] ?? []).find(
					(worktree) => worktree.id === worktreeId,
				)?.branch ?? null),
	);

	// After a worktree/project switch the status row in `byKey` is keyed by
	// the *new* (folderId, worktreeId), so reading `status` returns null
	// until the first refresh lands — which is the correct behavior. No
	// stale-branch flash during the swap.
	const resolvedBranch = resolveBranchLabel(
		status?.branch ?? null,
		projectedWorktreeBranch,
		cachedCloudContext?.branch ?? null,
	);
	const branchLabel = resolvedBranch.label;
	const branchIsCached = resolvedBranch.cached;
	const repoLabel =
		originLabel ??
		cachedCloudContext?.repositoryLabel ??
		folder?.name ??
		(ctx.status === "worktree-pending"
			? "Preparing repository"
			: "No repository");
	const originOwner =
		originLabel?.split("/", 1)[0] ?? cachedCloudContext?.owner ?? null;
	const showLeftToggle = !leftSidebarOpen;
	// When the left panel is open its own header carries the traffic-light
	// gutter, so this section starts flush. When it's collapsed we slide the
	// open-toggle into the leading slot — and in windowed mode reserve 80px
	// for the macOS controls. Native fullscreen hides those controls, so we
	// skip the reserve.
	const leftPad =
		showLeftToggle && isMacHost() && !isFullScreen ? "pl-20" : "pl-2";

	const refreshBranches = async (): Promise<void> => {
		if (executionRef === null || folderId === null) return;
		setBranchesLoading(true);
		setBranchError(null);
		try {
			const { result } = await dispatchGitWorkspaceCommand<
				{ readonly folderId: FolderId; readonly worktreeId: WorktreeId | null },
				ReadonlyArray<GitBranchInfo>
			>({
				ref: executionRef,
				kind: "git.branches",
				commandId: CommandId.make(`git-branches:${crypto.randomUUID()}`),
				payload: { folderId, worktreeId },
			});
			setBranches(result);
		} catch (err) {
			setBranchError(errorMessage(err));
		} finally {
			setBranchesLoading(false);
		}
	};

	useEffect(() => {
		void refreshBranches();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [folderId, worktreeId, branchLabel]);

	const switchToBranch = async (branch: GitBranchInfo): Promise<void> => {
		if (executionRef === null || folderId === null || branch.current) return;
		if (
			status !== null &&
			status.dirtyFiles > 0 &&
			!window.confirm(
				`Switch branches with ${status.dirtyFiles} uncommitted change${
					status.dirtyFiles === 1 ? "" : "s"
				}? Git may refuse if the changes conflict.`,
			)
		) {
			return;
		}
		setBranchesLoading(true);
		setBranchError(null);
		try {
			await dispatchGitWorkspaceCommand({
				ref: executionRef,
				kind: "git.switchBranch",
				commandId: CommandId.make(`git-switch:${crypto.randomUUID()}`),
				payload: {
					folderId,
					worktreeId,
					branch: branch.name,
					remote: branch.remote,
				},
			});
			void refreshGitWorkspace(executionRef);
			await refreshBranches();
		} catch (err) {
			setBranchError(errorMessage(err));
		} finally {
			setBranchesLoading(false);
		}
	};

	return (
		<div
			role="toolbar"
			aria-label={uiMessage("common:workspace_toolbar")}
			className={`${SECTION_CLASS} ${leftPad} bg-muted/20 ${rightSidebarOpen ? "pr-1" : NATIVE_CONTROLS_INSET_CLASS}`}
		>
			{showLeftToggle ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								type="button"
								onClick={() => setLeftSidebarOpen(true)}
								className={ICON_BUTTON_CLASS}
								aria-label={uiMessage("chat:top_bar_show_projects_panel")}
							>
								<HugeiconsIcon icon={PanelLeftOpenIcon} className="size-3.5" />
							</button>
						}
					/>
					<TooltipPopup>
						<TooltipShortcut
							label={uiMessage("chat:top_bar_show_projects_panel")}
							shortcut={formatShortcut("toggle-left-sidebar")}
						/>
					</TooltipPopup>
				</Tooltip>
			) : null}
			<div className={`flex min-w-0 flex-1 items-center ${ACTION_CLASS}`}>
				{hasSession ? (
					<nav
						aria-label={uiMessage("chat:top_bar_repository_location")}
						className="flex min-w-0 max-w-[min(460px,100%)] items-center gap-1 text-[11px]"
					>
						<Avatar className="mr-0.5 size-4 shrink-0 rounded-sm">
							{originOwner !== null ? (
								<AvatarImage
									src={`https://github.com/${encodeURIComponent(originOwner)}.png?size=32`}
									alt=""
								/>
							) : null}
							<AvatarFallback className="rounded-sm bg-foreground/8 text-[8px] text-muted-foreground">
								{repoLabel.slice(0, 1).toUpperCase()}
							</AvatarFallback>
						</Avatar>
						<span
							className="max-w-44 truncate font-medium text-foreground/90"
							title={repoLabel}
						>
							{repoLabel}
						</span>
						{branchLabel ? (
							<>
								<ChevronRight className="size-3 shrink-0 text-muted-foreground/50" />
								{branchIsCached ? (
									<span
										className="min-w-0 max-w-52 truncate px-1 text-muted-foreground"
										title={branchLabel}
									>
										{branchLabel}
									</span>
								) : (
									<BranchMenuButton
										branchLabel={branchLabel}
										branches={branches}
										canRename={worktreeId !== null}
										className="min-w-0 max-w-52 px-1 py-0 text-[11px] font-normal text-muted-foreground hover:text-foreground"
										dirtyFiles={status?.dirtyFiles ?? 0}
										error={branchError}
										loading={branchesLoading}
										onOpen={() => void refreshBranches()}
										onRename={() => {
											void loadRenameDialog();
											setRenameOpen(true);
										}}
										onSwitch={(branch) => void switchToBranch(branch)}
									/>
								)}
							</>
						) : null}
					</nav>
				) : null}
			</div>
			{renameOpen &&
			executionRef !== null &&
			folderId !== null &&
			worktreeId !== null &&
			branchLabel !== null ? (
				<Suspense fallback={null}>
					<RenameBranchDialog
						executionRef={executionRef}
						branchLabel={branchLabel}
						open
						onOpenChange={setRenameOpen}
						onRenamed={async () => {
							if (executionRef !== null)
								await refreshGitWorkspace(executionRef);
							await refreshWorktrees(folderId);
							await refreshBranches();
						}}
						worktreeId={worktreeId}
					/>
				</Suspense>
			) : null}
			{hasSession ? (
				isCloudWorkspace && ctx.status === "ready" ? (
					<CloudWorkspaceOpenSshMenu
						workspaceId={ctx.environmentId}
						className={ACTION_CLASS}
					/>
				) : (
					<OpenInMenu rootPath={ctx.status === "ready" ? ctx.rootPath : null} />
				)
			) : null}
			{hasSession ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								type="button"
								onClick={toggleEnvironmentSummary}
								className={`${ICON_BUTTON_CLASS} ${
									environmentSummaryOpen
										? "bg-foreground/10 text-foreground"
										: ""
								}`}
								aria-label={uiMessage(
									"chat:top_bar_toggle_environment_summary",
								)}
								aria-pressed={environmentSummaryOpen}
							>
								<HugeiconsIcon icon={Menu01Icon} className="size-3.5" />
							</button>
						}
					/>
					<TooltipPopup>
						{uiMessage("chat:top_bar_toggle_environment_summary")}
					</TooltipPopup>
				</Tooltip>
			) : null}
			{selectedChatRef !== null && ctx.status === "ready" ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								type="button"
								aria-label={uiMessage("common:toggle_bottom_terminal")}
								aria-pressed={bottomTerminalOpen}
								className={`${ICON_BUTTON_CLASS} ${bottomTerminalOpen ? "bg-foreground/10 text-foreground" : ""}`}
								onClick={() =>
									setBottomTerminalOpenForChat(
										selectedChatRef,
										!bottomTerminalOpen,
									)
								}
							>
								<PanelBottom className="size-3.5" />
							</button>
						}
					/>
					<TooltipPopup>
						{uiMessage("common:toggle_bottom_terminal")}
					</TooltipPopup>
				</Tooltip>
			) : null}
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							type="button"
							onClick={() => {
								if (selectedChatRef !== null)
									setRightSidebarOpenForChat(
										selectedChatRef,
										!rightSidebarOpen,
									);
							}}
							className={ICON_BUTTON_CLASS}
							aria-label={
								rightSidebarOpen
									? uiMessage("chat:top_bar_hide_files_panel")
									: uiMessage("chat:top_bar_show_files_panel")
							}
						>
							{rightSidebarOpen ? (
								<HugeiconsIcon
									icon={PanelRightCloseIcon}
									className="size-3.5"
								/>
							) : (
								<HugeiconsIcon icon={PanelRightOpenIcon} className="size-3.5" />
							)}
						</button>
					}
				/>
				<TooltipPopup>
					<TooltipShortcut
						label={
							rightSidebarOpen
								? uiMessage("chat:top_bar_hide_files_panel")
								: uiMessage("chat:top_bar_show_files_panel")
						}
						shortcut={formatShortcut("toggle-right-sidebar")}
					/>
				</TooltipPopup>
			</Tooltip>
		</div>
	);
}

export function BranchMenuButton({
	branchLabel,
	branches,
	canRename,
	className,
	popupSide = "bottom",
	dirtyFiles,
	error,
	loading,
	onOpen,
	onRename,
	onSwitch,
}: {
	branchLabel: string;
	branches: ReadonlyArray<GitBranchInfo>;
	canRename: boolean;
	className?: string;
	popupSide?: "bottom" | "left";
	dirtyFiles: number;
	error: string | null;
	loading: boolean;
	onOpen: () => void;
	onRename: () => void;
	onSwitch: (branch: GitBranchInfo) => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "projects", "common"]);

	const executionRef = executionRefFor(useActiveContext());
	const [createFrom, setCreateFrom] = useState<"HEAD" | "origin/main" | null>(
		null,
	);
	const [branchQuery, setBranchQuery] = useState("");
	const normalizedQuery = branchQuery.trim().toLocaleLowerCase();
	const matchingBranches = branches.filter((branch) => {
		if (normalizedQuery.length === 0) return true;
		return [branch.name, branch.remote, branch.upstream].some((value) =>
			value?.toLocaleLowerCase().includes(normalizedQuery),
		);
	});
	const localBranches = matchingBranches.filter((b) => b.kind === "local");
	const remoteBranches = matchingBranches.filter((b) => b.kind === "remote");

	return (
		<>
			<Menu
				modal={popupSide !== "left"}
				onOpenChange={(open) => !open && setBranchQuery("")}
			>
				<MenuTrigger
					onClick={onOpen}
					className={`flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-foreground outline-none hover:bg-foreground/5 data-[popup-open]:bg-foreground/5 ${className ?? "max-w-64"}`}
					aria-label={uiMessage("chat:top_bar_switch_branch")}
				>
					<HugeiconsIcon
						icon={GitBranchIcon}
						className="size-3.5 shrink-0 text-muted-foreground"
					/>
					<span
						className="min-w-0 flex-1 truncate text-left"
						title={branchLabel}
					>
						{branchLabel}
					</span>
					{dirtyFiles > 0 ? (
						<span className="shrink-0 text-muted-foreground">
							· {dirtyFiles}
						</span>
					) : null}
					{loading ? (
						<HugeiconsIcon
							icon={Loading02Icon}
							className="size-3 animate-spin text-muted-foreground"
						/>
					) : (
						<HugeiconsIcon
							icon={ArrowDown01Icon}
							className="size-3 shrink-0 text-muted-foreground"
						/>
					)}
				</MenuTrigger>
				<MenuPopup
					side={popupSide}
					sideOffset={popupSide === "left" ? 8 : 4}
					align="start"
					className="w-72"
				>
					{error !== null ? (
						<div className="max-w-72 px-2 py-1.5 text-[11px] leading-snug text-[var(--accent-red)]">
							{error}
						</div>
					) : null}
					{canRename ? (
						<>
							<MenuItem
								onClick={onRename}
								className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-xs hover:bg-sidebar-accent"
							>
								<HugeiconsIcon icon={PencilEdit01Icon} className="size-3.5" />
								{uiMessage("chat:top_bar_rename_current_branch")}
							</MenuItem>
							<MenuSeparator />
						</>
					) : null}
					<div className="sticky top-0 z-10 bg-glass px-1 pb-1">
						<label className="flex h-7 items-center gap-1.5 rounded-md px-2">
							<HugeiconsIcon
								icon={Search01Icon}
								className="size-3.5 shrink-0 text-muted-foreground"
							/>
							<span className="sr-only">
								{uiMessage("chat:top_bar_search_branches")}
							</span>
							<input
								type="search"
								value={branchQuery}
								onChange={(event) => setBranchQuery(event.target.value)}
								onKeyDown={(event) => {
									if (isInputComposing(event)) return;

									if (event.key !== "Escape") event.stopPropagation();
								}}
								placeholder={uiMessage("chat:top_bar_search_branches")}
								className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
							/>
						</label>
					</div>
					<div className="max-h-56 overflow-y-auto overscroll-contain">
						<MenuSectionLabel>
							{uiMessage("chat:top_bar_local_branches")}
						</MenuSectionLabel>
						{localBranches.length > 0 ? (
							localBranches.map((branch) => (
								<MenuItem
									key={`local:${branch.name}`}
									disabled={branch.current || loading}
									onClick={() => onSwitch(branch)}
									className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-xs hover:bg-sidebar-accent"
								>
									<HugeiconsIcon
										icon={Tick01Icon}
										className={`size-3.5 ${branch.current ? "opacity-100" : "opacity-0"}`}
									/>
									<span className="min-w-0 flex-1 truncate">{branch.name}</span>
									{branch.upstream !== null ? (
										<span className="max-w-28 truncate text-[10px] text-muted-foreground">
											{branch.upstream}
										</span>
									) : null}
								</MenuItem>
							))
						) : normalizedQuery.length === 0 ? (
							<div className="px-2 py-1.5 text-xs text-muted-foreground">
								{uiMessage("chat:top_bar_no_local_branches")}
							</div>
						) : null}
						{remoteBranches.length > 0 ? (
							<>
								<MenuSeparator />
								<MenuSectionLabel>
									{uiMessage("chat:top_bar_remote_branches")}
								</MenuSectionLabel>
								{remoteBranches.map((branch) => (
									<MenuItem
										key={`remote:${branch.remote ?? branch.name}`}
										disabled={loading}
										onClick={() => onSwitch(branch)}
										className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-xs hover:bg-sidebar-accent"
									>
										<HugeiconsIcon icon={GitBranchIcon} className="size-3.5" />
										<span className="min-w-0 flex-1 truncate">
											{branch.name}
										</span>
										{branch.remote !== null ? (
											<span className="max-w-28 truncate text-[10px] text-muted-foreground">
												{branch.remote}
											</span>
										) : null}
									</MenuItem>
								))}
							</>
						) : null}
						{matchingBranches.length === 0 ? (
							<div className="px-2 py-5 text-center text-xs text-muted-foreground">
								{uiMessage("chat:top_bar_no_matching_branches")}
							</div>
						) : null}
					</div>
					<MenuSeparator />
					<MenuItem
						disabled={loading || executionRef === null}
						onClick={() => setCreateFrom("HEAD")}
					>
						{uiMessage("projects:github_new_branch")}
					</MenuItem>
					<MenuItem
						disabled={loading || executionRef === null || dirtyFiles > 0}
						onClick={() => setCreateFrom("origin/main")}
					>
						{uiMessage("projects:github_new_origin_branch")}
					</MenuItem>
					{executionRef && (
						<GitStackMenu
							executionRef={executionRef}
							branch={branchLabel}
							variant="submenu"
						/>
					)}
				</MenuPopup>
			</Menu>
			{executionRef && createFrom ? (
				<CreateBranchDialog
					executionRef={executionRef}
					base={createFrom}
					onClose={() => {
						setCreateFrom(null);
						onOpen();
					}}
				/>
			) : null}
		</>
	);
}

function MenuSectionLabel({ children }: { children: ReactNode }) {
	return (
		<div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
			{children}
		</div>
	);
}

function RenameBranchDialog({
	branchLabel,
	executionRef,
	open,
	onOpenChange,
	onRenamed,
	worktreeId,
}: {
	branchLabel: string;
	executionRef: ExecutionRef;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRenamed: () => Promise<void>;
	worktreeId: WorktreeId;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "projects", "common"]);

	const rename = async (next: string) => {
		await dispatchGitWorkspaceCommand({
			ref: executionRef,
			kind: "worktree.renameBranch",
			commandId: CommandId.make(`worktree-rename:${crypto.randomUUID()}`),
			payload: { worktreeId, name: next },
		});
		await onRenamed();
	};

	return (
		<RenameDialog
			title={uiMessage("chat:top_bar_rename_branch")}
			description={uiMessage(
				"chat:top_bar_rename_the_unpublished_branch_for_this_chat_workspace",
			)}
			label={uiMessage("chat:top_bar_branch_name")}
			value={branchLabel}
			open={open}
			onOpenChange={onOpenChange}
			onRename={rename}
		/>
	);
}

function OpenInMenu({ rootPath }: { rootPath: string | null }) {
	const { message: uiMessage } = useUiMessages(["chat", "projects", "common"]);

	const capabilities = rendererPlatformCapabilities();
	const [targets, setTargets] = useState<ReadonlyArray<OpenTarget>>([]);
	const [loading, setLoading] = useState(false);
	const availableTargets = useMemo(
		() => targets.filter((target) => target.available),
		[targets, uiMessage],
	);
	const primary = availableTargets.find((target) => target.id === "finder");

	const refreshTargets = async (): Promise<void> => {
		if (rootPath === null) return;
		const bridge = window.zuse?.app;
		if (bridge?.listOpenTargets === undefined) return;
		setLoading(true);
		try {
			setTargets(await bridge.listOpenTargets(rootPath));
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void refreshTargets();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [rootPath]);

	const openTarget = async (target: OpenTarget): Promise<void> => {
		if (rootPath === null) return;
		const bridge = window.zuse?.app;
		if (target.id === "finder") {
			await bridge?.revealPath?.(rootPath);
			return;
		}
		await bridge?.openPathInApp?.(rootPath, target.id);
	};

	const copyPath = async (): Promise<void> => {
		if (rootPath === null) return;
		await window.zuse?.app?.copyPath?.(rootPath);
	};

	if (!capabilities.openInEditor && !capabilities.revealInFileManager) {
		return null;
	}

	return (
		<Menu>
			<Tooltip>
				<TooltipTrigger
					render={
						<MenuTrigger
							disabled={rootPath === null}
							onClick={() => void refreshTargets()}
							className={`${ACTION_CLASS} flex h-7 items-center overflow-hidden rounded-md border border-border/80 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:pointer-events-none disabled:opacity-50`}
							aria-label={uiMessage("chat:top_bar_open_workspace_in_app")}
						>
							<span className="flex size-7 items-center justify-center border-r border-border/80">
								{loading ? (
									<HugeiconsIcon
										icon={Loading02Icon}
										className="size-3.5 animate-spin"
									/>
								) : primary !== undefined ? (
									<OpenTargetIcon target={primary} />
								) : (
									<HugeiconsIcon icon={LinkSquare01Icon} className="size-3.5" />
								)}
							</span>
							<span className="flex size-7 items-center justify-center">
								<ChevronDown className="size-3.5" />
							</span>
						</MenuTrigger>
					}
				/>
				<TooltipPopup>{uiMessage("chat:top_bar_open_in")}</TooltipPopup>
			</Tooltip>
			<MenuPopup align="end" className="min-w-56">
				{availableTargets.map((target, index) => (
					<MenuItem
						key={target.id}
						onClick={() => void openTarget(target)}
						className="flex w-full items-center gap-3 rounded px-2 py-1.5 text-sm hover:bg-sidebar-accent"
					>
						<OpenTargetIcon target={target} />
						<span className="min-w-0 flex-1 truncate">{target.label}</span>
						<MenuShortcut>{index + 1}</MenuShortcut>
					</MenuItem>
				))}
				<MenuSeparator />
				<MenuItem
					onClick={() => void copyPath()}
					className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-sm hover:bg-sidebar-accent"
				>
					<HugeiconsIcon icon={Copy01Icon} className="size-4" />
					<span className="min-w-0 flex-1 truncate">
						{uiMessage("chat:top_bar_copy_path")}
					</span>
					<MenuShortcut>⌘⇧C</MenuShortcut>
				</MenuItem>
			</MenuPopup>
		</Menu>
	);
}

/**
 * Top bar over the files panel: a PR-integration cluster on the left
 * (clickable hash + live CI status) and the primary action(s) on the right.
 *
 * Mechanical actions run directly with a spinner (Merge, Mark ready, Push
 * commits, Auto-merge toggle, capturing CI logs). Actions that need the agent
 * (Resolve conflicts, Create PR, Commit & push, Fix CI) auto-submit a new chat
 * message — they never just pre-fill the composer.
 */
/**
 * Run the project's configured run script in a fresh dock terminal. Only
 * shown on a worktree whose repository has a non-empty `runScript` (matching
 * the old worktree pane's Run affordance, now promoted to the top bar).
 */
function RunButton() {
	const { message: uiMessage } = useUiMessages(["chat", "projects", "common"]);

	const ctx = useActiveContext();
	const folderId = ctx.status === "ready" ? ctx.folderId : null;
	const settings = useRepositorySettingsStore((s) =>
		folderId && ctx.status === "ready"
			? (s.byProject[repositorySettingsKey(ctx.environmentId, folderId)] ??
				null)
			: null,
	);
	const refreshSettings = useRepositorySettingsStore((s) => s.refresh);
	const startRun = useWorktreesStore((s) => s.startRun);

	useEffect(() => {
		if (folderId !== null && settings === null && ctx.status === "ready")
			void refreshSettings(ctx.environmentId, folderId);
	}, [ctx, folderId, settings, refreshSettings]);

	if (
		ctx.status !== "ready" ||
		ctx.rootKind !== "worktree" ||
		ctx.worktreePending ||
		ctx.worktreeId === null
	) {
		return null;
	}
	if ((settings?.runScript?.trim().length ?? 0) === 0) return null;

	const worktreeId = ctx.worktreeId;
	const onRun = async () => {
		// The Run button only renders for the active worktree, which belongs to
		// the selected chat — so the run terminal lands in that chat's dock.
		const chatId = useChatsStore.getState().selectedChatId;
		if (chatId === null) return;
		const run = await startRun(worktreeId);
		if (run === null) return;
		await openTerminalCommand({
			chatRef: { environmentId: ctx.environmentId, chatId },
			cwd: run.cwd,
			title: uiMessage("chat:top_bar_run"),
			command: { cmd: "/bin/zsh", args: ["-lc", run.script], env: run.env },
		});
	};

	return (
		<GlassActionButton
			tone="zinc"
			icon={<HugeiconsIcon icon={PlayIcon} />}
			label={uiMessage("chat:top_bar_run")}
			onClick={() => void onRun()}
		/>
	);
}

export function TopBarRight() {
	const { message: uiMessage } = useUiMessages(["chat", "projects", "common"]);

	const ctx = useActiveContext();
	const selectedChatId = useChatsStore((s) => s.selectedChatId);
	const resetKey =
		ctx.status === "ready"
			? `${ctx.environmentId}:${ctx.folderId}:${ctx.worktreeId ?? "main"}:${selectedChatId ?? "none"}`
			: `empty:${selectedChatId ?? "none"}`;

	return (
		<section
			aria-label={uiMessage("common:workflow_controls")}
			className="shrink-0"
		>
			<ErrorBoundary
				resetKey={resetKey}
				fallback={
					<div
						role="toolbar"
						aria-label={uiMessage("common:workflow_toolbar")}
						className={`${SECTION_CLASS} ${NATIVE_CONTROLS_INSET_CLASS} justify-between pl-2`}
					>
						<div className={ACTION_CLASS} />
						<div
							className={`text-[11px] text-[var(--accent-red)] ${ACTION_CLASS}`}
						>
							{uiMessage("chat:top_bar_actions_unavailable")}
						</div>
					</div>
				}
				onError={(error) => {
					console.error("[top-bar] action surface crashed", error);
				}}
			>
				<TopBarRightContent />
			</ErrorBoundary>
		</section>
	);
}

export function TopBarRightContent({
	compact = false,
}: {
	compact?: boolean;
} = {}) {
	const { message: uiMessage } = useUiMessages(["chat", "projects", "common"]);

	const ctx = useActiveContext();
	const executionRef = executionRefFor(ctx);
	const { gitView, pr } = useGitPrState(executionRef);
	const status = gitView.data?.status ?? null;
	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);

	const canCreatePrWhenSynced = canCreatePrFromSyncedBranch(
		status,
		ctx.status === "cloud-unavailable" || ctx.status === "worktree-pending"
			? { status: "empty" }
			: ctx,
	);
	const workflow = deriveBranchWorkflow(status, pr, canCreatePrWhenSynced);
	const agentReady = selectedSessionId !== null;

	return (
		<div
			role="toolbar"
			aria-label={uiMessage(
				compact ? "common:workflow_actions" : "common:workflow_toolbar",
			)}
			aria-orientation={compact ? "vertical" : "horizontal"}
			className={
				compact
					? "flex min-w-0 flex-col gap-2"
					: `${SECTION_CLASS} ${NATIVE_CONTROLS_INSET_CLASS} justify-between pl-2`
			}
		>
			<div className={`flex min-w-0 flex-1 items-center gap-2 ${ACTION_CLASS}`}>
				{agentReady && workflow.kind === "dirty" ? (
					<GlassChip tone="amber">
						{uiMessage("chat:top_bar_change_plural0_sentence", {
							value: workflow.count ?? "",
							count: workflow.count,
						})}
					</GlassChip>
				) : null}
				{agentReady && workflow.kind === "ahead" ? (
					<GlassChip tone="pink">
						{uiMessage("chat:top_bar_ahead_sentence", {
							value: workflow.count,
						})}
					</GlassChip>
				) : null}
				{agentReady && workflow.kind === "ready-for-pr" ? (
					<GlassChip tone="zinc">{uiMessage("chat:top_bar_no_pr")}</GlassChip>
				) : null}
				{agentReady && workflow.kind === "merged-pr" ? (
					<GlassChip tone="green">{uiMessage("chat:top_bar_merged")}</GlassChip>
				) : null}
				{agentReady && workflow.kind === "open-pr" ? (
					<>
						<PrHashChip workflow={workflow} />
						<CiStatus workflow={workflow} />
					</>
				) : null}
			</div>
			<WorkflowActions compact={compact} />
		</div>
	);
}

/**
 * The branch workflow action strip (Commit & push, Push commits, Create PR,
 * Archive chat, Resolve conflicts, Fix CI, Mark ready, Merge) — shared by
 * the top bar and the environment summary so both surfaces stay in sync.
 */
type WorkflowActionPresentation = "glass" | "inline";

function WorkflowActionButton({
	presentation,
	tone,
	icon,
	label,
	onClick,
	disabled,
}: {
	presentation: WorkflowActionPresentation;
	tone: GlassTone;
	icon: ReactNode;
	label: string;
	onClick: () => void;
	disabled?: boolean;
}) {
	if (presentation === "glass") {
		return (
			<GlassActionButton
				tone={tone}
				icon={icon}
				label={label}
				onClick={onClick}
				disabled={disabled}
			/>
		);
	}

	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="flex min-h-9 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-3.5"
		>
			{icon}
			{label}
		</button>
	);
}

export function ResolveConflictsButton({
	presentation = "glass",
}: {
	presentation?: WorkflowActionPresentation;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "projects", "common"]);

	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
	const ctx = useActiveContext();
	const setActiveMainTab = useUiStore((s) => s.setActiveMainTab);

	return (
		<WorkflowActionButton
			presentation={presentation}
			tone="red"
			icon={
				<HugeiconsIcon
					icon={presentation === "inline" ? Wrench01Icon : Alert01Icon}
				/>
			}
			label={
				presentation === "inline"
					? uiMessage("chat:top_bar_fix")
					: uiMessage("chat:top_bar_resolve_conflicts")
			}
			disabled={selectedSessionId === null}
			onClick={() => {
				if (selectedSessionId === null || ctx.status !== "ready") return;
				setActiveMainTab("chat");
				void sendSessionMessage(
					{ environmentId: ctx.environmentId, sessionId: selectedSessionId },
					"this pull request has merge conflicts — help me resolve them",
				);
			}}
		/>
	);
}

export function WorkflowActions({
	compact = false,
	includeRun = true,
	includeHealthActions = true,
	presentation = "glass",
	className = "",
}: {
	compact?: boolean;
	includeRun?: boolean;
	includeHealthActions?: boolean;
	presentation?: WorkflowActionPresentation;
	className?: string;
}) {
	const [createFromMain, setCreateFromMain] = useState(false);
	const { message: uiMessage } = useUiMessages(["chat", "projects", "common"]);

	const ctx = useActiveContext();
	const executionRef = executionRefFor(ctx);
	const folderId = ctx.status === "ready" ? ctx.folderId : null;
	const worktreeId = ctx.status === "ready" ? ctx.worktreeId : null;
	const { gitView, pr } = useGitPrState(executionRef);
	const status = gitView.data?.status ?? null;
	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
	const selectedChatId = useChatsStore((s) => s.selectedChatId);
	const archiveProgress = useChatsStore((s) =>
		selectedChatId === null
			? null
			: (s.archiveProgressByChat[selectedChatId] ?? null),
	);
	const setActiveMainTab = useUiStore((s) => s.setActiveMainTab);

	const sendToAgent = (text: string) => {
		if (selectedSessionId === null || ctx.status !== "ready") return;
		setActiveMainTab("chat");
		void sendSessionMessage(
			{ environmentId: ctx.environmentId, sessionId: selectedSessionId },
			text,
		);
	};

	const canCreatePrWhenSynced = canCreatePrFromSyncedBranch(
		status,
		ctx.status === "cloud-unavailable" || ctx.status === "worktree-pending"
			? { status: "empty" }
			: ctx,
	);
	const workflow = deriveBranchWorkflow(status, pr, canCreatePrWhenSynced);
	const agentReady = selectedSessionId !== null;

	return (
		<div
			className={`flex shrink-0 items-center gap-1 ${ACTION_CLASS} ${
				compact ? "flex-wrap" : ""
			} ${className}`}
		>
			{includeRun ? <RunButton /> : null}
			{workflow.kind === "dirty" ? (
				<WorkflowActionButton
					presentation={presentation}
					tone="amber"
					icon={<HugeiconsIcon icon={Upload01Icon} />}
					label={uiMessage("chat:top_bar_commit_push")}
					disabled={!agentReady}
					onClick={() => sendToAgent("commit and push the current changes")}
				/>
			) : null}
			{workflow.kind === "ahead" && folderId !== null ? (
				// Pushing committed changes needs no agent — do it directly.
				<DirectActionButton
					presentation={presentation}
					tone="pink"
					icon={<HugeiconsIcon icon={Upload01Icon} />}
					label={
						presentation === "inline"
							? uiMessage("chat:top_bar_push")
							: uiMessage("chat:top_bar_push_commits")
					}
					loadingLabel="Pushing…"
					run={async () => {
						if (executionRef === null) return;
						await dispatchGitWorkspaceCommand({
							ref: executionRef,
							kind: "git.push",
							commandId: CommandId.make(`git-push:${crypto.randomUUID()}`),
							payload: { folderId, worktreeId },
						});
					}}
					onSuccess={() => {
						if (executionRef !== null) void refreshGitWorkspace(executionRef);
					}}
				/>
			) : null}
			{workflow.kind === "ready-for-pr" ? (
				<WorkflowActionButton
					presentation={presentation}
					tone="pink"
					icon={<HugeiconsIcon icon={GitPullRequestIcon} />}
					label={uiMessage("chat:top_bar_create_pr")}
					disabled={!agentReady}
					onClick={() => sendToAgent("create a pull request for this branch")}
				/>
			) : null}
			{workflow.kind === "merged-pr" && executionRef !== null ? (
				<>
					<Tooltip>
						<TooltipTrigger
							render={
								<button
									type="button"
									className="h-7 rounded-md px-2 text-xs hover:bg-muted"
									onClick={() => setCreateFromMain(true)}
								>
									{uiMessage("common:continue")}
								</button>
							}
						/>
						<TooltipPopup>
							{uiMessage("projects:github_continue_tooltip")}
						</TooltipPopup>
					</Tooltip>
					{createFromMain ? (
						<CreateBranchDialog
							executionRef={executionRef}
							base="origin/main"
							onClose={() => setCreateFromMain(false)}
						/>
					) : null}
				</>
			) : null}
			{workflow.kind === "merged-pr" && selectedChatId !== null ? (
				<DirectActionButton
					presentation={presentation}
					tone="zinc"
					icon={<HugeiconsIcon icon={ArchiveArrowDownIcon} />}
					label={
						archiveProgress === null
							? presentation === "inline"
								? uiMessage("chat:top_bar_archive")
								: uiMessage("chat:top_bar_archive_chat")
							: chatArchiveProgressLabel(archiveProgress)
					}
					loadingLabel={
						archiveProgress === null
							? "Archiving…"
							: chatArchiveProgressLabel(archiveProgress)
					}
					disabled={archiveProgress !== null}
					run={() => archiveChatWithConfirm(selectedChatId)}
				/>
			) : null}
			{includeHealthActions &&
			workflow.kind === "open-pr" &&
			workflow.mergeable === "conflicting" ? (
				<ResolveConflictsButton presentation={presentation} />
			) : null}
			{includeHealthActions &&
			workflow.kind === "open-pr" &&
			workflow.mergeable !== "conflicting" &&
			workflow.checks === "failure" &&
			folderId !== null ? (
				<FixActionsButton
					presentation={presentation}
					folderId={folderId}
					worktreeId={worktreeId}
					disabled={!agentReady}
				/>
			) : null}
			{workflow.kind === "open-pr" &&
			workflow.mergeable !== "conflicting" &&
			workflow.checks !== "failure" &&
			workflow.isDraft &&
			folderId !== null ? (
				<DirectActionButton
					presentation={presentation}
					tone="zinc"
					icon={<HugeiconsIcon icon={GitMergeIcon} />}
					label={uiMessage("chat:top_bar_mark_ready")}
					loadingLabel="Marking…"
					run={async () => {
						if (executionRef === null) return;
						await dispatchGitWorkspaceCommand({
							ref: executionRef,
							kind: "git.markReady",
							commandId: CommandId.make(
								`git-mark-ready:${crypto.randomUUID()}`,
							),
							payload: { folderId, worktreeId },
						});
					}}
					onSuccess={() => {
						if (executionRef !== null) void refreshGitWorkspace(executionRef);
					}}
				/>
			) : null}
			{workflow.kind === "open-pr" &&
			workflow.mergeable !== "conflicting" &&
			workflow.checks !== "failure" &&
			!workflow.isDraft &&
			folderId !== null ? (
				workflow.checks === "pending" ? (
					<AutoMergeToggle
						presentation={presentation}
						folderId={folderId}
						worktreeId={worktreeId}
						enabled={workflow.autoMergeEnabled}
					/>
				) : (
					<MergeButton
						presentation={presentation}
						folderId={folderId}
						worktreeId={worktreeId}
					/>
				)
			) : null}
		</div>
	);
}

const openPrChipTone = (w: OpenPrWorkflow): GlassTone => {
	if (w.mergeable === "conflicting") return "red";
	if (w.checks === "failure") return "red";
	if (w.checks === "pending") return "amber";
	if (w.isDraft) return "zinc";
	return "green";
};

/**
 * PR number pill. Clicking it opens the PR on GitHub in the OS browser.
 * Tinted by the same workflow tone the merge button uses.
 */
function PrHashChip({ workflow }: { workflow: OpenPrWorkflow }) {
	const { message: uiMessage } = useUiMessages(["chat", "projects", "common"]);

	const checksRunning = workflow.checksRunning;
	const label =
		checksRunning > 0
			? `${checksRunning} check${checksRunning === 1 ? "" : "s"} running`
			: `#${workflow.number ?? "?"}`;
	const content =
		checksRunning > 0 ? (
			<span className="flex items-center gap-1.5">
				<HugeiconsIcon icon={Loading02Icon} className="size-3 animate-spin" />
				{label}
			</span>
		) : (
			label
		);
	if (workflow.url === null) {
		return <GlassChip tone={openPrChipTone(workflow)}>{content}</GlassChip>;
	}
	const url = workflow.url;
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={() => openExternal(url)}
						className="cursor-pointer rounded-md transition-opacity hover:opacity-80"
						aria-label={uiMessage("chat:top_bar_open_pull_request_on_github", {
							value1: String(workflow.number ?? "?"),
						})}
					>
						<GlassChip tone={openPrChipTone(workflow)}>{content}</GlassChip>
					</button>
				}
			/>
			<TooltipPopup>
				{uiMessage("chat:top_bar_open_pull_request_on_github_sentence", {
					value: workflow.number ?? "?",
				})}
			</TooltipPopup>
		</Tooltip>
	);
}

/**
 * Live CI rollup readout sourced from the canonical Git workspace snapshot.
 *   running → spinner + "N checks running"
 *   failing → "N checks failing" (red)
 *   passing → "Checks passed" (green)
 *   none    → nothing
 */
function CiStatus({ workflow }: { workflow: OpenPrWorkflow }) {
	const { message: uiMessage } = useUiMessages(["chat", "projects", "common"]);

	if (workflow.checksTotal === 0) return null;
	if (workflow.checksRunning > 0) return null;
	if (workflow.checksFailing > 0) {
		const n = workflow.checksFailing;
		return (
			<span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-[var(--accent-red)]">
				<HugeiconsIcon icon={Alert01Icon} className="size-3.5" />
				{n}
				{uiMessage("chat:top_bar_check")}
				{n === 1 ? "" : "s"}
				{uiMessage("chat:top_bar_failing")}
			</span>
		);
	}
	return null;
}

/**
 * GlassActionButton wrapper for direct (non-agent) git/gh actions. Shows a
 * spinner while the RPC is in flight and reports failures through the global
 * toast surface. The user can retry once loading clears.
 */
function DirectActionButton({
	presentation = "glass",
	tone,
	icon,
	label,
	loadingLabel,
	disabled,
	run,
	onSuccess,
}: {
	presentation?: WorkflowActionPresentation;
	tone: GlassTone;
	icon: ReactNode;
	label: string;
	loadingLabel: string;
	disabled?: boolean;
	run: () => Promise<unknown>;
	onSuccess?: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "projects", "common"]);

	const [loading, setLoading] = useState(false);

	const onClick = async () => {
		if (loading) return;
		setLoading(true);
		try {
			await run();
			onSuccess?.();
		} catch (err) {
			toastManager.add({
				type: "error",
				title: uiMessage("chat:top_bar_failed", { label: String(label) }),
				description: errorMessage(err),
			});
		} finally {
			setLoading(false);
		}
	};

	return (
		<WorkflowActionButton
			presentation={presentation}
			tone={tone}
			icon={
				loading ? (
					<HugeiconsIcon icon={Loading02Icon} className="animate-spin" />
				) : (
					icon
				)
			}
			label={loading ? loadingLabel : label}
			disabled={disabled || loading}
			onClick={onClick}
		/>
	);
}

const MERGE_METHOD_LABEL: Record<GitMergeMethod, string> = {
	merge: "Create a merge commit",
	squash: "Squash and merge",
	rebase: "Rebase and merge",
};

/**
 * Direct Merge button + method picker. The chevron opens a menu to choose
 * merge / squash / rebase; the choice is remembered (merge-prefs store) so the
 * next PR defaults to it, mirroring GitHub's behaviour. Disabled while checks
 * are still pending.
 */
function MergeButton({
	presentation = "glass",
	folderId,
	worktreeId,
}: {
	presentation?: WorkflowActionPresentation;
	folderId: FolderId;
	worktreeId: WorktreeId | null;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "projects", "common"]);

	const executionRef = executionRefFor(useActiveContext());
	const method = useMergePrefs((s) => s.method);
	const deleteBranch = useMergePrefs((s) => s.deleteBranch);
	const setMethod = useMergePrefs((s) => s.setMethod);

	return (
		<div className="flex items-center gap-1">
			<DirectActionButton
				presentation={presentation}
				tone="green"
				icon={<HugeiconsIcon icon={GitMergeIcon} />}
				label={uiMessage("chat:top_bar_merge")}
				loadingLabel="Merging…"
				run={async () => {
					if (executionRef === null) return;
					await dispatchGitWorkspaceCommand({
						ref: executionRef,
						kind: "git.mergePr",
						commandId: CommandId.make(`git-merge:${crypto.randomUUID()}`),
						payload: {
							folderId,
							worktreeId,
							action: "merge",
							method,
							deleteBranch,
						},
					});
				}}
				onSuccess={() => {
					if (executionRef !== null) void refreshGitWorkspace(executionRef);
				}}
			/>
			<Menu>
				<Tooltip>
					<TooltipTrigger
						render={
							<MenuTrigger
								className="flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
								aria-label={uiMessage("chat:top_bar_choose_merge_method")}
							>
								<ChevronDown className="size-3.5" />
							</MenuTrigger>
						}
					/>
					<TooltipPopup>{uiMessage("chat:top_bar_merge_method")}</TooltipPopup>
				</Tooltip>
				<MenuPopup align="end" className="min-w-[200px]">
					{(["merge", "squash", "rebase"] as const).map((m) => (
						<MenuItem
							key={m}
							onClick={() => setMethod(m)}
							className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-xs hover:bg-sidebar-accent"
						>
							<HugeiconsIcon
								icon={Tick01Icon}
								className={`size-3.5 ${method === m ? "opacity-100" : "opacity-0"}`}
							/>
							{MERGE_METHOD_LABEL[m]}
						</MenuItem>
					))}
				</MenuPopup>
			</Menu>
		</div>
	);
}

/**
 * Auto-merge toggle. Arms / disarms GitHub-native auto-merge via
 * `gh pr merge --auto` / `--disable-auto`. The enabled state is sourced from
 * canonical PR state (`autoMergeEnabled`), so it reflects GitHub's truth even
 * across app restarts. If the repo doesn't allow auto-merge, gh's error
 * surfaces in the warning tooltip.
 */
function AutoMergeToggle({
	presentation = "glass",
	folderId,
	worktreeId,
	enabled,
}: {
	presentation?: WorkflowActionPresentation;
	folderId: FolderId;
	worktreeId: WorktreeId | null;
	enabled: boolean;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "projects", "common"]);

	const executionRef = executionRefFor(useActiveContext());
	const method = useMergePrefs((s) => s.method);
	const deleteBranch = useMergePrefs((s) => s.deleteBranch);
	const [loading, setLoading] = useState(false);

	const toggle = async () => {
		if (loading) return;
		setLoading(true);
		try {
			if (executionRef === null) return;
			await dispatchGitWorkspaceCommand({
				ref: executionRef,
				kind: "git.mergePr",
				commandId: CommandId.make(`git-auto-merge:${crypto.randomUUID()}`),
				payload: {
					folderId,
					worktreeId,
					action: enabled ? "disable-auto" : "enable-auto",
					method,
					deleteBranch,
				},
			});
			if (executionRef !== null) await refreshGitWorkspace(executionRef);
		} catch (err) {
			toastManager.add({
				type: "error",
				title: uiMessage("chat:top_bar_auto_merge_failed"),
				description: errorMessage(err),
			});
		} finally {
			setLoading(false);
		}
	};

	const tip = enabled
		? "Auto-merge is on. GitHub will merge this PR automatically once all required checks pass. Click to turn off."
		: `Auto-merge on success — GitHub merges this PR automatically once all required checks pass, using your selected merge method (${method}). Requires the repository to allow auto-merge.`;

	if (presentation === "inline") {
		return (
			<Tooltip>
				<TooltipTrigger
					render={
						<WorkflowActionButton
							presentation="inline"
							tone="blue"
							icon={
								loading ? (
									<HugeiconsIcon
										icon={Loading02Icon}
										className="animate-spin"
									/>
								) : (
									<HugeiconsIcon icon={MagicWand01Icon} />
								)
							}
							label={
								enabled
									? uiMessage("chat:top_bar_auto_merge_on")
									: uiMessage("chat:top_bar_auto_merge")
							}
							disabled={loading}
							onClick={() => void toggle()}
						/>
					}
				/>
				<TooltipPopup className="max-w-xs">{tip}</TooltipPopup>
			</Tooltip>
		);
	}

	return (
		<div className="flex items-center gap-1">
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							type="button"
							onClick={() => void toggle()}
							disabled={loading}
							style={
								{ ["--tone" as string]: "var(--accent-blue)" } as CSSProperties
							}
							className={`glass-tone flex h-7 items-center gap-1.5 rounded-[10px] px-2.5 text-[11px] font-semibold tracking-tight transition-opacity disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-3.5 ${
								enabled ? "" : "opacity-60 hover:opacity-90"
							}`}
							aria-pressed={enabled}
						>
							{loading ? (
								<HugeiconsIcon icon={Loading02Icon} className="animate-spin" />
							) : (
								<HugeiconsIcon icon={MagicWand01Icon} />
							)}
							{enabled
								? uiMessage("chat:top_bar_auto_merge_on")
								: uiMessage("chat:top_bar_auto_merge")}
						</button>
					}
				/>
				<TooltipPopup className="max-w-xs">{tip}</TooltipPopup>
			</Tooltip>
		</div>
	);
}

const errorMessage = (err: unknown): string => {
	if (typeof err === "object" && err !== null && "reason" in err) {
		const reason = (err as { reason?: unknown }).reason;
		if (typeof reason === "string" && reason.length > 0) return reason;
	}
	if (err instanceof Error && err.message.length > 0) return err.message;
	return "Something went wrong.";
};

/**
 * Failing-checks CTA. Asks the server to drop a captured
 * `.zuse/failing-checks-<ts>.txt` artifact, then **auto-submits** a new chat
 * message referencing it as a file ref — the agent starts working immediately,
 * no manual Send.
 *
 * Stateful (loading spinner) because the server has to call `gh run view
 * --log-failed` once per failing run; on a chunky pipeline this can take a
 * couple seconds.
 */
export function FixActionsButton({
	presentation = "glass",
	folderId,
	worktreeId,
	disabled,
}: {
	presentation?: WorkflowActionPresentation;
	folderId: FolderId;
	worktreeId: WorktreeId | null;
	disabled: boolean;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "projects", "common"]);

	const executionRef = executionRefFor(useActiveContext());
	const [loading, setLoading] = useState(false);
	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
	const setActiveMainTab = useUiStore((s) => s.setActiveMainTab);

	const onClick = async () => {
		if (loading || selectedSessionId === null || executionRef === null) return;
		setLoading(true);
		try {
			const { result: artifact } = await dispatchGitWorkspaceCommand<
				{ readonly folderId: FolderId; readonly worktreeId: WorktreeId | null },
				GitFailingChecksArtifact
			>({
				ref: executionRef,
				kind: "git.fixFailingChecks",
				commandId: CommandId.make(`git-fix-checks:${crypto.randomUUID()}`),
				payload: { folderId, worktreeId },
			});
			setActiveMainTab("chat");
			const input = new ComposerInput({
				text: "Please look at the failing CI checks captured in this log and fix them.",
				attachments: [],
				fileRefs: [
					{
						relPath: artifact.relPath,
						absPath: artifact.absPath,
						kind: "file",
					},
				],
				skillRefs: [],
			});
			await sendSessionMessage(
				{
					environmentId: executionRef.environmentId,
					sessionId: selectedSessionId,
				},
				input,
			);
		} catch {
			// Server already surfaces a GitCommandError; nothing useful to render
			// in-place. The user can retry — leave the button enabled.
		} finally {
			setLoading(false);
		}
	};

	return (
		<WorkflowActionButton
			presentation={presentation}
			tone="red"
			icon={
				loading ? (
					<HugeiconsIcon icon={Loading02Icon} className="animate-spin" />
				) : (
					<HugeiconsIcon icon={Wrench01Icon} />
				)
			}
			label={
				loading
					? uiMessage("chat:top_bar_capturing")
					: presentation === "inline"
						? uiMessage("chat:top_bar_fix")
						: uiMessage("chat:top_bar_fix_ci_errors")
			}
			disabled={disabled || loading}
			onClick={onClick}
		/>
	);
}
