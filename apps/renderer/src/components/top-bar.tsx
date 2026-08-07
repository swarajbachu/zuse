import { HugeiconsIcon } from "@hugeicons/react";
import {
	Alert01Icon,
	ArchiveArrowDownIcon,
	ArrowDown01Icon,
	ArrowRight01Icon,
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
} from "@hugeicons-pro/core-solid-rounded";
import {
	type AccountAccessProviderStatus,
	ComposerInput,
	type FolderId,
	type GitBranchInfo,
	type GitMergeMethod,
	type MachineRecord,
	type WorktreeId,
} from "@zuse/contracts";
import { Effect } from "effect";
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
} from "../lib/branch-workflow.ts";
import type { OpenTarget } from "../lib/bridge.ts";
import { requestCloudAccountAccess } from "../lib/cloud-account-access-intent.ts";
import { isMacHost } from "../lib/host-platform.ts";
import { rendererPlatformCapabilities } from "../lib/platform-capabilities.ts";
import {
	getActiveEnvironmentId,
	getControlPlaneRpcClient,
	getRpcClient,
	selectEnvironment,
} from "../lib/rpc-client.ts";
import { openTerminalCommand } from "../lib/run-terminal.ts";
import { formatShortcut } from "../lib/shortcuts.ts";
import { useActiveContext } from "../store/active-workspace.ts";
import {
	archiveChatWithConfirm,
	chatArchiveProgressLabel,
	useChatsStore,
} from "../store/chats.ts";
import { gitStatusKey, useGitStatusStore } from "../store/git-status.ts";
import { useMergePrefs } from "../store/merge-prefs.ts";
import { useMessagesStore } from "../store/messages.ts";
import { prStateKey, usePrStateStore } from "../store/pr-state.ts";
import { useRepositorySettingsStore } from "../store/repository-settings.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { useWorktreesStore } from "../store/worktrees.ts";
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
	"flex h-8 shrink-0 items-center gap-1 border-b border-border text-[11px] [-webkit-app-region:drag]";
const ACTION_CLASS = "[-webkit-app-region:no-drag]";
const ICON_BUTTON_CLASS = `${ACTION_CLASS} flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground`;
const NATIVE_CONTROLS_INSET_CLASS =
	"pr-[calc(var(--zuse-window-controls-right-inset)+0.25rem)]";

/**
 * Top bar over the projects panel: product name on the left + a left-pane
 * collapse toggle on the right. In windowed mode we leave 80px clear at
 * the start so the macOS traffic-light controls have room; in fullscreen
 * the controls are gone, so we hug the edge instead.
 */
export function TopBarLeft() {
	const setLeftSidebarOpen = useUiStore((s) => s.setLeftSidebarOpen);
	const isFullScreen = useUiStore((s) => s.isFullScreen);
	const reserveMacTrafficLights = isMacHost() && !isFullScreen;

	return (
		<header
			className={`${SECTION_CLASS} pr-1 ${reserveMacTrafficLights ? "pl-20" : "pl-3"}`}
		>
			<span className="truncate font-semibold tracking-tight text-foreground">
				Zuse (Beta)
			</span>
			{rendererPlatformCapabilities().desktop ? (
				<>
					<EnvironmentSelector />
					<CloudGithubAccessShortcut />
				</>
			) : null}
			<span className="flex-1" />
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							type="button"
							onClick={() => setLeftSidebarOpen(false)}
							className={ICON_BUTTON_CLASS}
							aria-label="Hide projects panel"
						>
							<HugeiconsIcon icon={PanelLeftCloseIcon} className="size-3.5" />
						</button>
					}
				/>
				<TooltipPopup>
					<TooltipShortcut
						label="Hide projects panel"
						shortcut={formatShortcut("toggle-left-sidebar")}
					/>
				</TooltipPopup>
			</Tooltip>
		</header>
	);
}

function CloudGithubAccessShortcut() {
	const setView = useUiStore((state) => state.setView);
	const setSettingsSection = useUiStore((state) => state.setSettingsSection);
	const environmentId = getActiveEnvironmentId();
	const [githubStatus, setGithubStatus] =
		useState<AccountAccessProviderStatus | null>(null);

	useEffect(() => {
		if (environmentId === null) {
			setGithubStatus(null);
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const client = await getRpcClient();
				const status = await Effect.runPromise(
					client["accountAccess.status"](),
				);
				if (!cancelled) {
					setGithubStatus(
						status.providers.find(
							(provider) => provider.providerId === "github",
						) ?? null,
					);
				}
			} catch {
				if (!cancelled) setGithubStatus(null);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [environmentId]);

	if (environmentId === null) {
		return null;
	}

	return (
		<span className="flex w-[6.75rem] shrink-0 items-center">
			{githubStatus?.installed && githubStatus.state !== "connected" ? (
				<CloudGithubAccessShortcutButton
					onClick={() => {
						requestCloudAccountAccess(window.sessionStorage, window, "github");
						setSettingsSection({ kind: "machines" });
						setView("settings");
					}}
				/>
			) : null}
		</span>
	);
}

export function CloudGithubAccessShortcutButton({
	onClick,
}: {
	readonly onClick: () => void;
}) {
	return (
		<button
			type="button"
			className={`${ACTION_CLASS} flex min-h-8 w-full shrink-0 items-center justify-center rounded-md px-2 font-medium text-foreground hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
			aria-label="Connect GitHub to this cloud machine"
			onClick={onClick}
		>
			Connect GitHub
		</button>
	);
}

function EnvironmentSelector() {
	const setView = useUiStore((state) => state.setView);
	const setSettingsSection = useUiStore((state) => state.setSettingsSection);
	const [machines, setMachines] = useState<ReadonlyArray<MachineRecord>>([]);
	const [loading, setLoading] = useState(false);
	const activeEnvironmentId = getActiveEnvironmentId();
	const activeMachine = machines.find(
		(machine) => machine.environmentId === activeEnvironmentId,
	);
	const label =
		activeEnvironmentId === null
			? "This Mac"
			: (activeMachine?.label ?? "Cloud machine");

	const load = async () => {
		setLoading(true);
		try {
			const client = await getControlPlaneRpcClient();
			const result = await Effect.runPromise(client["machines.list"]());
			setMachines(
				result.machines.filter(
					(machine) =>
						machine.state === "ready" && machine.environmentId !== undefined,
				),
			);
		} catch {
			setMachines([]);
		} finally {
			setLoading(false);
		}
	};

	return (
		<Menu onOpenChange={(open) => open && void load()}>
			<MenuTrigger
				render={
					<button
						type="button"
						className={`${ACTION_CLASS} flex min-h-8 min-w-0 max-w-40 items-center gap-1 rounded-md px-2 text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
						aria-label={`Environment: ${label}`}
					>
						<span className="truncate">{label}</span>
						<HugeiconsIcon
							icon={loading ? Loading02Icon : ArrowDown01Icon}
							className={`size-3 shrink-0 ${loading ? "animate-spin" : ""}`}
						/>
					</button>
				}
			/>
			<MenuPopup align="start" className="min-w-56">
				<MenuItem
					onClick={() => void selectEnvironment(null)}
					className="flex min-h-11 items-center gap-2"
				>
					<HugeiconsIcon
						icon={Tick01Icon}
						className={`size-3.5 ${
							activeEnvironmentId === null ? "opacity-100" : "opacity-0"
						}`}
					/>
					This Mac
				</MenuItem>
				{machines.map((machine) => (
					<MenuItem
						key={machine.machineId}
						onClick={() =>
							void selectEnvironment(machine.environmentId ?? null)
						}
						className="flex min-h-11 items-center gap-2"
					>
						<HugeiconsIcon
							icon={Tick01Icon}
							className={`size-3.5 ${
								machine.environmentId === activeEnvironmentId
									? "opacity-100"
									: "opacity-0"
							}`}
						/>
						<span className="min-w-0 flex-1 truncate">
							{machine.label ?? machine.offer.displayName}
						</span>
						<span className="text-[10px] text-muted-foreground">Ready</span>
					</MenuItem>
				))}
				<MenuSeparator />
				<MenuItem
					onClick={() => {
						setSettingsSection({ kind: "machines" });
						setView("settings");
					}}
					className="min-h-11"
				>
					New Cloud Machine
				</MenuItem>
				{activeEnvironmentId !== null && activeMachine === undefined ? (
					<>
						<MenuSeparator />
						<div
							role="alert"
							className="max-w-64 px-2 py-1.5 text-[11px] text-destructive"
						>
							This environment is unavailable. Return to This Mac to recover.
						</div>
					</>
				) : null}
			</MenuPopup>
		</Menu>
	);
}

/**
 * Top bar over the main pane. Holds the projects-panel open-toggle (only
 * when that panel is collapsed), the branch label, and the right-pane
 * open/close toggle (always visible — the user expects to find it here
 * regardless of which way the files panel is currently leaning).
 */
export function TopBarMain() {
	// Pull folderId + worktreeId from the canonical active context so the
	// branch label can never disagree with the terminal cwd, file tree root,
	// or composer chip — they all read from the same hook.
	const ctx = useActiveContext();
	const folderId = ctx.status === "ready" ? ctx.folderId : null;
	const worktreeId = ctx.status === "ready" ? ctx.worktreeId : null;
	const status = useGitStatusStore((s) =>
		folderId ? (s.byKey[gitStatusKey(folderId, worktreeId)] ?? null) : null,
	);
	const refresh = useGitStatusStore((s) => s.refresh);
	const refreshWorktrees = useWorktreesStore((s) => s.refresh);
	const refreshPr = usePrStateStore((s) => s.refresh);
	const leftSidebarOpen = useUiStore((s) => s.leftSidebarOpen);
	const setLeftSidebarOpen = useUiStore((s) => s.setLeftSidebarOpen);
	const selectedChatId = useChatsStore((s) => s.selectedChatId);
	const rightSidebarOpen = useUiStore((s) =>
		selectedChatId === null
			? false
			: (s.rightPaneLayoutByChat[selectedChatId]?.open ?? false),
	);
	const setRightSidebarOpen = useUiStore((s) => s.setRightSidebarOpen);
	const isFullScreen = useUiStore((s) => s.isFullScreen);
	const environmentSummaryOpen = useUiStore((s) => s.environmentSummaryOpen);
	const toggleEnvironmentSummary = useUiStore(
		(s) => s.toggleEnvironmentSummary,
	);
	// On the empty new-chat landing (no session yet) we hide the repo/branch
	// label + open-in menu so the surface reads as a clean blank chat. The
	// sidebar toggle buttons stay.
	const hasSession = useSessionsStore((s) => s.selectedSessionId !== null);
	const folder = useWorkspaceStore((s) =>
		folderId ? (s.folders.find((f) => f.id === folderId) ?? null) : null,
	);
	const [originLabel, setOriginLabel] = useState<string | null>(null);
	const [branches, setBranches] = useState<ReadonlyArray<GitBranchInfo>>([]);
	const [branchesLoading, setBranchesLoading] = useState(false);
	const [branchError, setBranchError] = useState<string | null>(null);
	const [renameOpen, setRenameOpen] = useState(false);

	// Poll both `git status` (branch / dirty / ahead) and the PR state (CI
	// rollup, mergeable, auto-merge) on the same 5s tick so the top-bar PR
	// cluster shows live "N checks running" without the PR pane being open.
	useEffect(() => {
		if (folderId === null) return;
		const tick = () => {
			void refresh(folderId, worktreeId);
			void refreshPr(folderId, worktreeId);
		};
		tick();
		const id = window.setInterval(tick, 5000);
		return () => window.clearInterval(id);
	}, [folderId, refresh, refreshPr, worktreeId]);

	// After a worktree/project switch the status row in `byKey` is keyed by
	// the *new* (folderId, worktreeId), so reading `status` returns null
	// until the first refresh lands — which is the correct behavior. No
	// stale-branch flash during the swap.
	const branchLabel = status?.branch ?? null;
	const repoLabel = originLabel ?? folder?.name ?? "No repository";
	const originOwner = originLabel?.split("/", 1)[0] ?? null;
	const showLeftToggle = !leftSidebarOpen;
	// When the left panel is open its own header carries the traffic-light
	// gutter, so this section starts flush. When it's collapsed we slide the
	// open-toggle into the leading slot — and in windowed mode reserve 80px
	// for the macOS controls. Native fullscreen hides those controls, so we
	// skip the reserve.
	const leftPad =
		showLeftToggle && isMacHost() && !isFullScreen ? "pl-20" : "pl-2";

	useEffect(() => {
		if (folderId === null) {
			setOriginLabel(null);
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const client = await getRpcClient();
				const origin = await Effect.runPromise(
					client["git.origin"]({ folderId }),
				);
				if (cancelled) return;
				setOriginLabel(
					origin !== null ? `${origin.owner}/${origin.repo}` : null,
				);
			} catch {
				if (!cancelled) setOriginLabel(null);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [folderId]);

	const refreshBranches = async (): Promise<void> => {
		if (folderId === null) return;
		setBranchesLoading(true);
		setBranchError(null);
		try {
			const client = await getRpcClient();
			const list = await Effect.runPromise(
				client["git.branches"]({ folderId, worktreeId }),
			);
			setBranches(list);
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
		if (folderId === null || branch.current) return;
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
			const client = await getRpcClient();
			await Effect.runPromise(
				client["git.switchBranch"]({
					folderId,
					worktreeId,
					branch: branch.name,
					remote: branch.remote,
				}),
			);
			refreshAfterAction(folderId, worktreeId);
			await refreshBranches();
		} catch (err) {
			setBranchError(errorMessage(err));
		} finally {
			setBranchesLoading(false);
		}
	};

	return (
		<header
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
								aria-label="Show projects panel"
							>
								<HugeiconsIcon icon={PanelLeftOpenIcon} className="size-3.5" />
							</button>
						}
					/>
					<TooltipPopup>
						<TooltipShortcut
							label="Show projects panel"
							shortcut={formatShortcut("toggle-left-sidebar")}
						/>
					</TooltipPopup>
				</Tooltip>
			) : null}
			<div className={`flex min-w-0 flex-1 items-center ${ACTION_CLASS}`}>
				{hasSession ? (
					<nav
						aria-label="Repository location"
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
								<HugeiconsIcon
									icon={ArrowRight01Icon}
									className="size-3 shrink-0 text-muted-foreground/50"
								/>
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
							</>
						) : null}
					</nav>
				) : null}
			</div>
			{renameOpen &&
			folderId !== null &&
			worktreeId !== null &&
			branchLabel !== null ? (
				<Suspense fallback={null}>
					<RenameBranchDialog
						branchLabel={branchLabel}
						open
						onOpenChange={setRenameOpen}
						onRenamed={async () => {
							refreshAfterAction(folderId, worktreeId);
							await refreshWorktrees(folderId);
							await refreshBranches();
						}}
						worktreeId={worktreeId}
					/>
				</Suspense>
			) : null}
			{hasSession ? (
				<OpenInMenu rootPath={ctx.status === "ready" ? ctx.rootPath : null} />
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
								aria-label="Toggle environment summary"
								aria-pressed={environmentSummaryOpen}
							>
								<HugeiconsIcon icon={Menu01Icon} className="size-3.5" />
							</button>
						}
					/>
					<TooltipPopup>Toggle environment summary</TooltipPopup>
				</Tooltip>
			) : null}
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							type="button"
							onClick={() => setRightSidebarOpen(!rightSidebarOpen)}
							className={ICON_BUTTON_CLASS}
							aria-label={
								rightSidebarOpen ? "Hide files panel" : "Show files panel"
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
						label={rightSidebarOpen ? "Hide files panel" : "Show files panel"}
						shortcut={formatShortcut("toggle-right-sidebar")}
					/>
				</TooltipPopup>
			</Tooltip>
		</header>
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
		<Menu onOpenChange={(open) => !open && setBranchQuery("")}>
			<MenuTrigger
				onClick={onOpen}
				className={`flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-medium text-foreground outline-none hover:bg-foreground/5 data-[popup-open]:bg-foreground/5 ${className ?? "max-w-64"}`}
				aria-label="Switch branch"
			>
				<HugeiconsIcon
					icon={GitBranchIcon}
					className="size-3.5 shrink-0 text-muted-foreground"
				/>
				<span className="truncate" title={branchLabel}>
					{branchLabel}
				</span>
				{dirtyFiles > 0 ? (
					<span className="shrink-0 text-muted-foreground">· {dirtyFiles}</span>
				) : null}
				{loading ? (
					<HugeiconsIcon
						icon={Loading02Icon}
						className="size-3 animate-spin text-muted-foreground"
					/>
				) : (
					<HugeiconsIcon
						icon={ArrowDown01Icon}
						className="size-3 text-muted-foreground"
					/>
				)}
			</MenuTrigger>
			<MenuPopup
				side={popupSide}
				sideOffset={popupSide === "left" ? 8 : 4}
				align="center"
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
							Rename current branch…
						</MenuItem>
						<MenuSeparator />
					</>
				) : null}
				<div className="sticky top-0 z-10 bg-glass px-1 pb-1">
					<label className="flex h-7 items-center gap-1.5 rounded-md border border-border/70 bg-background/50 px-2 focus-within:border-ring/60">
						<HugeiconsIcon
							icon={Search01Icon}
							className="size-3.5 shrink-0 text-muted-foreground"
						/>
						<span className="sr-only">Search branches</span>
						<input
							type="search"
							value={branchQuery}
							onChange={(event) => setBranchQuery(event.target.value)}
							onKeyDown={(event) => {
								if (event.key !== "Escape") event.stopPropagation();
							}}
							placeholder="Search branches"
							className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
						/>
					</label>
				</div>
				<div className="max-h-56 overflow-y-auto overscroll-contain">
					<MenuSectionLabel>Local branches</MenuSectionLabel>
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
							No local branches
						</div>
					) : null}
					{remoteBranches.length > 0 ? (
						<>
							<MenuSeparator />
							<MenuSectionLabel>Remote branches</MenuSectionLabel>
							{remoteBranches.map((branch) => (
								<MenuItem
									key={`remote:${branch.remote ?? branch.name}`}
									disabled={loading}
									onClick={() => onSwitch(branch)}
									className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-xs hover:bg-sidebar-accent"
								>
									<HugeiconsIcon icon={GitBranchIcon} className="size-3.5" />
									<span className="min-w-0 flex-1 truncate">{branch.name}</span>
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
							No matching branches
						</div>
					) : null}
				</div>
			</MenuPopup>
		</Menu>
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
	open,
	onOpenChange,
	onRenamed,
	worktreeId,
}: {
	branchLabel: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRenamed: () => Promise<void>;
	worktreeId: WorktreeId;
}) {
	const rename = async (next: string) => {
		const client = await getRpcClient();
		await Effect.runPromise(
			client["worktree.renameBranch"]({ worktreeId, name: next }),
		);
		await onRenamed();
	};

	return (
		<RenameDialog
			title="Rename branch"
			description="Rename the unpublished branch for this chat workspace."
			label="Branch name"
			value={branchLabel}
			open={open}
			onOpenChange={onOpenChange}
			onRename={rename}
		/>
	);
}

function OpenInMenu({ rootPath }: { rootPath: string | null }) {
	const capabilities = rendererPlatformCapabilities();
	const [targets, setTargets] = useState<ReadonlyArray<OpenTarget>>([]);
	const [loading, setLoading] = useState(false);
	const availableTargets = useMemo(
		() => targets.filter((target) => target.available),
		[targets],
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
							aria-label="Open workspace in app"
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
								<HugeiconsIcon icon={ArrowDown01Icon} className="size-3.5" />
							</span>
						</MenuTrigger>
					}
				/>
				<TooltipPopup>Open in…</TooltipPopup>
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
					<span className="min-w-0 flex-1 truncate">Copy path</span>
					<MenuShortcut>⌘⇧C</MenuShortcut>
				</MenuItem>
			</MenuPopup>
		</Menu>
	);
}

/**
 * Refresh both git status and PR state after a direct git/gh action so the
 * top-bar workflow re-derives immediately rather than waiting for the next
 * 5s poll.
 */
const refreshAfterAction = (
	folderId: FolderId,
	worktreeId: WorktreeId | null,
): void => {
	void useGitStatusStore.getState().refresh(folderId, worktreeId);
	void usePrStateStore.getState().refresh(folderId, worktreeId);
};

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
	const ctx = useActiveContext();
	const folderId = ctx.status === "ready" ? ctx.folderId : null;
	const settings = useRepositorySettingsStore((s) =>
		folderId ? (s.byProject[folderId] ?? null) : null,
	);
	const refreshSettings = useRepositorySettingsStore((s) => s.refresh);
	const startRun = useWorktreesStore((s) => s.startRun);

	useEffect(() => {
		if (folderId !== null && settings === null) void refreshSettings(folderId);
	}, [folderId, settings, refreshSettings]);

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
		openTerminalCommand({
			chatId,
			cwd: run.cwd,
			title: "Run",
			command: { cmd: "/bin/zsh", args: ["-lc", run.script], env: run.env },
		});
	};

	return (
		<GlassActionButton
			tone="zinc"
			icon={<HugeiconsIcon icon={PlayIcon} />}
			label="Run"
			onClick={() => void onRun()}
		/>
	);
}

export function TopBarRight() {
	const ctx = useActiveContext();
	const selectedChatId = useChatsStore((s) => s.selectedChatId);
	const resetKey =
		ctx.status === "ready"
			? `${ctx.folderId}:${ctx.worktreeId ?? "main"}:${selectedChatId ?? "none"}`
			: `empty:${selectedChatId ?? "none"}`;

	return (
		<ErrorBoundary
			resetKey={resetKey}
			fallback={
				<header
					className={`${SECTION_CLASS} ${NATIVE_CONTROLS_INSET_CLASS} justify-between pl-2`}
				>
					<div className={ACTION_CLASS} />
					<div
						className={`text-[11px] text-[var(--accent-red)] ${ACTION_CLASS}`}
					>
						Actions unavailable
					</div>
				</header>
			}
			onError={(error) => {
				console.error("[top-bar] action surface crashed", error);
			}}
		>
			<TopBarRightContent />
		</ErrorBoundary>
	);
}

export function TopBarRightContent({
	compact = false,
}: {
	compact?: boolean;
} = {}) {
	const ctx = useActiveContext();
	const folderId = ctx.status === "ready" ? ctx.folderId : null;
	const worktreeId = ctx.status === "ready" ? ctx.worktreeId : null;
	const status = useGitStatusStore((s) =>
		folderId ? (s.byKey[gitStatusKey(folderId, worktreeId)] ?? null) : null,
	);
	const pr = usePrStateStore((s) =>
		folderId ? (s.byKey[prStateKey(folderId, worktreeId)] ?? null) : null,
	);
	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);

	const canCreatePrWhenSynced = canCreatePrFromSyncedBranch(status, ctx);
	const workflow = deriveBranchWorkflow(status, pr, canCreatePrWhenSynced);
	const agentReady = selectedSessionId !== null;

	const Root = compact ? "div" : "header";
	return (
		<Root
			className={
				compact
					? "flex min-w-0 flex-col gap-2"
					: `${SECTION_CLASS} ${NATIVE_CONTROLS_INSET_CLASS} justify-between pl-2`
			}
		>
			<div className={`flex min-w-0 flex-1 items-center gap-2 ${ACTION_CLASS}`}>
				{agentReady && workflow.kind === "dirty" ? (
					<GlassChip tone="amber">
						{workflow.count} change{workflow.count === 1 ? "" : "s"}
					</GlassChip>
				) : null}
				{agentReady && workflow.kind === "ahead" ? (
					<GlassChip tone="pink">{workflow.count} ahead</GlassChip>
				) : null}
				{agentReady && workflow.kind === "ready-for-pr" ? (
					<GlassChip tone="zinc">No PR</GlassChip>
				) : null}
				{agentReady && workflow.kind === "merged-pr" ? (
					<GlassChip tone="green">Merged</GlassChip>
				) : null}
				{agentReady && workflow.kind === "open-pr" ? (
					<>
						<PrHashChip workflow={workflow} />
						<CiStatus workflow={workflow} />
					</>
				) : null}
			</div>
			<WorkflowActions compact={compact} />
		</Root>
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
	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
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
			label={presentation === "inline" ? "Fix" : "Resolve conflicts"}
			disabled={selectedSessionId === null}
			onClick={() => {
				if (selectedSessionId === null) return;
				setActiveMainTab("chat");
				void useMessagesStore
					.getState()
					.send(
						selectedSessionId,
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
	const ctx = useActiveContext();
	const folderId = ctx.status === "ready" ? ctx.folderId : null;
	const worktreeId = ctx.status === "ready" ? ctx.worktreeId : null;
	const status = useGitStatusStore((s) =>
		folderId ? (s.byKey[gitStatusKey(folderId, worktreeId)] ?? null) : null,
	);
	const pr = usePrStateStore((s) =>
		folderId ? (s.byKey[prStateKey(folderId, worktreeId)] ?? null) : null,
	);
	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
	const selectedChatId = useChatsStore((s) => s.selectedChatId);
	const archiveProgress = useChatsStore((s) =>
		selectedChatId === null
			? null
			: (s.archiveProgressByChat[selectedChatId] ?? null),
	);
	const setActiveMainTab = useUiStore((s) => s.setActiveMainTab);

	const sendToAgent = (text: string) => {
		if (selectedSessionId === null) return;
		setActiveMainTab("chat");
		void useMessagesStore.getState().send(selectedSessionId, text);
	};

	const canCreatePrWhenSynced = canCreatePrFromSyncedBranch(status, ctx);
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
					label="Commit & push"
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
					label={presentation === "inline" ? "Push" : "Push commits"}
					loadingLabel="Pushing…"
					run={async () => {
						const client = await getRpcClient();
						await Effect.runPromise(
							client["git.push"]({ folderId, worktreeId }),
						);
					}}
					onSuccess={() => refreshAfterAction(folderId, worktreeId)}
				/>
			) : null}
			{workflow.kind === "ready-for-pr" ? (
				<WorkflowActionButton
					presentation={presentation}
					tone="pink"
					icon={<HugeiconsIcon icon={GitPullRequestIcon} />}
					label="Create PR"
					disabled={!agentReady}
					onClick={() => sendToAgent("create a pull request for this branch")}
				/>
			) : null}
			{workflow.kind === "merged-pr" && selectedChatId !== null ? (
				<DirectActionButton
					presentation={presentation}
					tone="zinc"
					icon={<HugeiconsIcon icon={ArchiveArrowDownIcon} />}
					label={
						archiveProgress === null
							? presentation === "inline"
								? "Archive"
								: "Archive chat"
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
					label="Mark ready"
					loadingLabel="Marking…"
					run={async () => {
						const client = await getRpcClient();
						await Effect.runPromise(
							client["git.markReady"]({ folderId, worktreeId }),
						);
					}}
					onSuccess={() => refreshAfterAction(folderId, worktreeId)}
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
						aria-label={`Open pull request #${workflow.number ?? "?"} on GitHub`}
					>
						<GlassChip tone={openPrChipTone(workflow)}>{content}</GlassChip>
					</button>
				}
			/>
			<TooltipPopup>
				Open pull request #{workflow.number ?? "?"} on GitHub
			</TooltipPopup>
		</Tooltip>
	);
}

/**
 * Live CI rollup readout. Polled via the top-bar's 5s pr-state refresh.
 *   running → spinner + "N checks running"
 *   failing → "N checks failing" (red)
 *   passing → "Checks passed" (green)
 *   none    → nothing
 */
function CiStatus({ workflow }: { workflow: OpenPrWorkflow }) {
	if (workflow.checksTotal === 0) return null;
	if (workflow.checksRunning > 0) return null;
	if (workflow.checksFailing > 0) {
		const n = workflow.checksFailing;
		return (
			<span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-[var(--accent-red)]">
				<HugeiconsIcon icon={Alert01Icon} className="size-3.5" />
				{n} check{n === 1 ? "" : "s"} failing
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
				title: `${label} failed`,
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
	const method = useMergePrefs((s) => s.method);
	const deleteBranch = useMergePrefs((s) => s.deleteBranch);
	const setMethod = useMergePrefs((s) => s.setMethod);

	return (
		<div className="flex items-center gap-1">
			<DirectActionButton
				presentation={presentation}
				tone="green"
				icon={<HugeiconsIcon icon={GitMergeIcon} />}
				label="Merge"
				loadingLabel="Merging…"
				run={async () => {
					const client = await getRpcClient();
					await Effect.runPromise(
						client["git.mergePr"]({
							folderId,
							worktreeId,
							action: "merge",
							method,
							deleteBranch,
						}),
					);
				}}
				onSuccess={() => refreshAfterAction(folderId, worktreeId)}
			/>
			<Menu>
				<Tooltip>
					<TooltipTrigger
						render={
							<MenuTrigger
								className="flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
								aria-label="Choose merge method"
							>
								<HugeiconsIcon icon={ArrowDown01Icon} className="size-3.5" />
							</MenuTrigger>
						}
					/>
					<TooltipPopup>Merge method</TooltipPopup>
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
 * polled PR state (`autoMergeEnabled`), so it reflects GitHub's truth even
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
	const method = useMergePrefs((s) => s.method);
	const deleteBranch = useMergePrefs((s) => s.deleteBranch);
	const [loading, setLoading] = useState(false);

	const toggle = async () => {
		if (loading) return;
		setLoading(true);
		try {
			const client = await getRpcClient();
			await Effect.runPromise(
				client["git.mergePr"]({
					folderId,
					worktreeId,
					action: enabled ? "disable-auto" : "enable-auto",
					method,
					deleteBranch,
				}),
			);
			refreshAfterAction(folderId, worktreeId);
		} catch (err) {
			toastManager.add({
				type: "error",
				title: "Auto-merge failed",
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
							label={enabled ? "Auto-merge on" : "Auto-merge"}
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
							{enabled ? "Auto-merge on" : "Auto-merge"}
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
	const [loading, setLoading] = useState(false);
	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
	const setActiveMainTab = useUiStore((s) => s.setActiveMainTab);

	const onClick = async () => {
		if (loading || selectedSessionId === null) return;
		setLoading(true);
		try {
			const client = await getRpcClient();
			const artifact = await Effect.runPromise(
				client["git.fixFailingChecks"]({ folderId, worktreeId }),
			);
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
			await useMessagesStore.getState().send(selectedSessionId, input);
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
					? "Capturing…"
					: presentation === "inline"
						? "Fix"
						: "Fix CI errors"
			}
			disabled={disabled || loading}
			onClick={onClick}
		/>
	);
}
