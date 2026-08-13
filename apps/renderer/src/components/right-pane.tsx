import { HugeiconsIcon } from "@hugeicons/react";
import type { ChatRef, ExecutionRef } from "@zuse/client-runtime/resource-ref";
import {
	EnvironmentId,
	type Folder,
	type FolderId,
	type WorktreeId,
} from "@zuse/contracts";
import {
	CheckListIcon,
	ComputerTerminal01Icon,
	Folder01Icon,
	GitCompareIcon,
	GitPullRequestIcon,
	GlobeIcon,
	MagicWand01Icon,
} from "@zuse/icons/solid-rounded";
import { latestProposedPlanMarkdown } from "@zuse/utils/proposed-plan";
import { Plus, X } from "lucide-react";
import { lazy, Suspense, useMemo, useRef, useSyncExternalStore } from "react";
import { cloudSummaryForChat } from "../lib/cloud-workspace-catalog.ts";
import { ensureCloudWorkspaceAttached } from "../lib/cloud-workspaces.ts";
import { useActiveSessionById } from "../lib/environment-entity-hooks.ts";
import { useGitWorkspaceResource } from "../lib/git-workspace-client-bus.ts";
import { rendererPlatformCapabilities } from "../lib/platform-capabilities.ts";
import { isSessionTurnActive } from "../lib/session-runtime-state.ts";
import { useOptionalRendererSessionTimeline } from "../lib/session-timeline-hooks.ts";
import { formatShortcut } from "../lib/shortcuts.ts";
import * as terminalRegistry from "../lib/terminal-registry.ts";
import { useAutoAnimate } from "../lib/use-auto-animate.ts";
import { useActiveContext } from "../store/active-workspace.ts";
import { useChatsStore } from "../store/chats.ts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { useRegisterPane } from "../store/pane-focus.ts";
import { useSessionsStore } from "../store/sessions.ts";
import {
	EMPTY_TERMINALS,
	terminalsKey,
	useTerminalsStore,
} from "../store/terminals.ts";
import {
	EMPTY_PANELS,
	type PanelInstance,
	type PanelKind,
	rightPaneKey,
	SINGLETON_PANEL_KINDS,
	useUiStore,
} from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { DiffPane } from "./diff-pane.tsx";
import { FileTree } from "./file-tree.tsx";
import { MarkdownBody } from "./markdown-body.tsx";
import { PrPane } from "./pr-pane.tsx";
import { SubagentsPane } from "./subagents-pane.tsx";
import { TerminalSlotPane } from "./terminal-pane.tsx";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuShortcut,
	MenuTrigger,
} from "./ui/menu.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

const BrowserPaneHost = lazy(() =>
	import("./browser-pane.tsx").then((module) => ({
		default: module.BrowserPaneHost,
	})),
);

/**
 * The right pane has two folder identities for a cloud chat: the logical
 * desktop project used to render project UI, and the sandbox checkout used by
 * live RPCs. Resolve project presence exclusively from the logical selection.
 */
export const logicalRightPaneProject = (
	folders: ReadonlyArray<Folder>,
	selectedFolderId: FolderId | null,
): Folder | null =>
	selectedFolderId === null
		? null
		: (folders.find((folder) => folder.id === selectedFolderId) ?? null);

/**
 * Metadata for each addable panel kind: launcher/tab label, icon, and the
 * keyboard shortcut to surface (only Terminal has one today).
 */
const PANEL_META: Record<
	PanelKind,
	{
		readonly label: string;
		readonly icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
		readonly shortcut?: string;
	}
> = {
	files: { label: "Files", icon: Folder01Icon },
	terminal: {
		label: "Terminal",
		icon: ComputerTerminal01Icon,
		shortcut: formatShortcut("toggle-terminal"),
	},
	changes: { label: "Changes", icon: GitCompareIcon },
	pr: { label: "PR", icon: GitPullRequestIcon },
	plan: { label: "Plan", icon: CheckListIcon },
	browser: { label: "Browser", icon: GlobeIcon },
	subagents: { label: "Subagents", icon: MagicWand01Icon },
};

const LIVE_PANEL_KINDS = new Set<PanelKind>([
	"files",
	"terminal",
	"changes",
	"pr",
	"browser",
]);

/** Primary surfaces shown in the empty launcher and standard add menu. */
const PRIMARY_PANEL_ORDER: ReadonlyArray<PanelKind> = [
	"files",
	"pr",
	"changes",
	"terminal",
	"browser",
];

const latestAssistantText = (
	messages: ReadonlyArray<import("@zuse/contracts").Message>,
): string | null => {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const content = messages[index]?.content;
		if (content?._tag !== "assistant") continue;
		const text = content.text.trim();
		return text.length > 0 ? text : null;
	}
	return null;
};

/**
 * Kinds the user can still add: every kind, minus singletons that are
 * already open. Terminal is always offered (multi-instance).
 */
function addableKinds(
	panels: ReadonlyArray<PanelInstance>,
): ReadonlyArray<PanelKind> {
	const openSingletons = new Set(
		panels.filter((p) => SINGLETON_PANEL_KINDS.has(p.kind)).map((p) => p.kind),
	);
	return PRIMARY_PANEL_ORDER.filter(
		(k) => k === "terminal" || !openSingletons.has(k),
	);
}

/**
 * Right-pane dock. The panel set is user-managed: nothing is shown until the
 * user adds a panel from the launcher (empty state) or the trailing "+" menu.
 * Terminal can be added multiple times (each its own tab); Files / Changes /
 * PR / Browser are singletons. All open panels mount once and stay mounted
 * (`hidden` toggling) so switching tabs preserves terminal scrollback,
 * file-tree expansion, the browser webview, and any in-flight PR fetch.
 */
export function RightPane({
	directoryUnavailable = false,
}: {
	directoryUnavailable?: boolean;
}) {
	const paneRef = useRef<HTMLElement>(null);
	useRegisterPane("rightPane", paneRef);
	const ctx = useActiveContext();
	const folders = useWorkspaceStore((s) => s.folders);
	const logicalSelectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
	const executionFolderId = ctx.status === "ready" ? ctx.folderId : null;
	const executionRootPath = ctx.status === "ready" ? ctx.rootPath : null;
	const worktreeId = ctx.status === "ready" ? ctx.worktreeId : null;
	const executionRef = useMemo<ExecutionRef | null>(
		() =>
			ctx.status !== "ready"
				? null
				: {
						environmentId: ctx.environmentId,
						folderId: ctx.folderId,
						worktreeId: ctx.worktreeId,
						rootPath: ctx.rootPath,
					},
		[ctx],
	);
	const selected = logicalRightPaneProject(folders, logicalSelectedFolderId);
	const workspaceView = useGitWorkspaceResource(executionRef, "connect");
	const status = workspaceView.data?.status ?? null;
	const pr = workspaceView.data?.pr ?? null;
	const details = workspaceView.data?.prDetails ?? null;
	// Dock layout + terminals are scoped to the selected sidebar chat, so each
	// chat keeps its own open tabs and running shells.
	const chatId = useChatsStore((s) => s.selectedChatId);
	const catalogEnvironmentId = EnvironmentId.make(
		useEnvironmentCatalogStore((state) => state.activeEnvironmentId),
	);
	const cloudSummaryCandidate =
		chatId === null ? null : cloudSummaryForChat(chatId);
	const chatRef = useMemo<ChatRef | null>(() => {
		if (chatId === null) return null;
		return {
			environmentId:
				ctx.status === "ready"
					? ctx.environmentId
					: ctx.status === "cloud-unavailable"
						? EnvironmentId.make(ctx.workspaceId)
						: catalogEnvironmentId,
			chatId,
		};
	}, [catalogEnvironmentId, chatId, ctx]);
	const cloudSummary =
		cloudSummaryCandidate?.workspaceId === chatRef?.environmentId
			? cloudSummaryCandidate
			: null;
	const chatKey = chatRef === null ? null : rightPaneKey(chatRef);
	const sessionId = useSessionsStore((s) => s.selectedSessionId);
	const session = useActiveSessionById(sessionId);
	const timeline = useOptionalRendererSessionTimeline(
		sessionId,
		"connect",
		chatRef?.environmentId ?? null,
	);
	const messages = timeline.messages;
	const isRunning = session !== null && isSessionTurnActive(timeline.runtime);
	const planMarkdown = useMemo(
		() =>
			latestProposedPlanMarkdown(messages) ??
			(session?.providerId === "codex" &&
			session.permissionMode === "plan" &&
			!isRunning
				? latestAssistantText(messages)
				: null),
		[isRunning, messages, session?.permissionMode, session?.providerId],
	);
	// Terminal tab titles are sourced from the chat's terminal list (slot →
	// instance) so multiple terminal tabs read "zsh", "zsh 2".
	const termList = useTerminalsStore((s) =>
		chatRef
			? (s.byKey[terminalsKey(chatRef)] ?? EMPTY_TERMINALS)
			: EMPTY_TERMINALS,
	);
	const terminalStatuses = useSyncExternalStore(
		terminalRegistry.subscribeStatuses,
		terminalRegistry.getStatusesSnapshot,
		terminalRegistry.getStatusesSnapshot,
	);

	const panels = useUiStore((s) =>
		chatKey ? (s.rightPanelsByChat[chatKey] ?? EMPTY_PANELS) : EMPTY_PANELS,
	);
	const activeId = useUiStore((s) =>
		chatKey ? (s.activeRightPanelByChat[chatKey] ?? null) : null,
	);
	const addPanel = useUiStore((s) => s.addPanel);
	const closePanel = useUiStore((s) => s.closePanel);
	const setActive = useUiStore((s) => s.setActiveRightPanel);
	const openChanges = useUiStore((s) => s.openChanges);
	const requestCloudAttachment = () => {
		if (cloudSummary !== null)
			void ensureCloudWorkspaceAttached(cloudSummary).catch(() => {});
	};
	const handleAddPanel = (kind: PanelKind) => {
		if (chatRef === null) return;
		addPanel(chatRef, kind);
		if (LIVE_PANEL_KINDS.has(kind)) requestCloudAttachment();
	};
	const addablePanels = addableKinds(panels).filter(
		(kind) =>
			!directoryUnavailable ||
			(kind !== "files" && kind !== "terminal" && kind !== "changes"),
	);

	// Glide dock tabs when panels are opened or closed. Declared with the other
	// hooks (above the `selected === null` early return) to satisfy hook rules.
	const dockTabsRef = useAutoAnimate<HTMLDivElement>();

	// Defensive: if the stored active id ever points at a closed panel, fall
	// back to the first one so exactly one panel body is visible.
	// A plan panel belongs to the selected session's final output. Keep its
	// persisted layout slot, but do not expose an empty tab while another
	// session in the same chat has no proposed plan.
	const visiblePanels =
		planMarkdown === null
			? panels.filter((panel) => panel.kind !== "plan")
			: panels;
	const effectiveActiveId =
		activeId !== null && visiblePanels.some((p) => p.id === activeId)
			? activeId
			: (visiblePanels[0]?.id ?? null);

	// Closing a terminal tab also drops (and kills) its backing PTY instance
	// for the chat (the store action is layout-only — it can't know the chat
	// key). `closePanel` then re-indexes remaining terminal slots, so panels
	// and instances stay aligned.
	const handleClose = (panel: PanelInstance) => {
		if (panel.kind === "terminal" && chatRef !== null) {
			const key = terminalsKey(chatRef);
			const inst = (useTerminalsStore.getState().byKey[key] ?? EMPTY_TERMINALS)[
				panel.slot
			];
			if (inst !== undefined) {
				useTerminalsStore.getState().remove(chatRef, inst.id);
			}
		}
		if (chatRef !== null) closePanel(chatRef, panel.id);
	};

	const tabLabel = (panel: PanelInstance): string =>
		panel.kind === "terminal"
			? (termList[panel.slot]?.title ?? PANEL_META.terminal.label)
			: PANEL_META[panel.kind].label;

	const tabBadge = (panel: PanelInstance): React.ReactNode => {
		if (panel.kind === "changes") {
			return renderChangesBadge(status?.dirtyFiles ?? 0);
		}
		if (panel.kind === "pr") return renderPrBadge(pr, details);
		if (panel.kind === "terminal") {
			const instance = termList[panel.slot];
			const failed =
				instance !== undefined &&
				terminalStatuses[
					terminalRegistry.terminalRuntimeKey(
						instance.environmentId,
						instance.id,
					)
				] === "failed";
			if (failed) {
				return (
					<span
						role="status"
						title="Terminal disconnected — close it and open a new terminal"
						className="size-1.5 shrink-0 rounded-full bg-rose-400"
					>
						<span className="sr-only">
							Terminal disconnected — close it and open a new terminal
						</span>
					</span>
				);
			}
			return (
				<span
					aria-hidden="true"
					className="size-1.5 shrink-0 rounded-full bg-transparent"
				/>
			);
		}
		return null;
	};

	if (selected === null) {
		return (
			<aside className="flex h-full min-h-0 w-full flex-col">
				<p className="px-3 py-6 text-center text-xs text-muted-foreground">
					No project selected.
				</p>
			</aside>
		);
	}

	const activePanel =
		visiblePanels.find((p) => p.id === effectiveActiveId) ?? null;
	const browserActive = activePanel?.kind === "browser";
	const browserAvailable = rendererPlatformCapabilities().integratedBrowser;
	const addPanelMenu = (
		<AddPanelMenu addable={addablePanels} onAdd={handleAddPanel} />
	);

	return (
		<aside
			ref={paneRef}
			data-pane="rightPane"
			tabIndex={-1}
			className="flex h-full min-h-0 w-full flex-col outline-none"
		>
			{visiblePanels.length > 0 ? (
				<div
					ref={dockTabsRef}
					className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto px-1 text-[11px]"
				>
					{visiblePanels.map((panel) => (
						<PanelTab
							key={panel.id}
							active={panel.id === effectiveActiveId}
							icon={PANEL_META[panel.kind].icon}
							label={tabLabel(panel)}
							badge={tabBadge(panel)}
							onSelect={() => {
								if (chatRef !== null) setActive(chatRef, panel.id);
								if (LIVE_PANEL_KINDS.has(panel.kind)) requestCloudAttachment();
								if (panel.kind === "changes") openChanges();
							}}
							onClose={() => handleClose(panel)}
						/>
					))}
					{addPanelMenu}
				</div>
			) : null}
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				{visiblePanels.length === 0 ? (
					<PanelLauncher
						actions={addPanelMenu}
						addable={addablePanels}
						onAdd={handleAddPanel}
					/>
				) : null}
				{/* Non-browser panels: mount on add, kept mounted while open. */}
				{ctx.status === "worktree-pending" && visiblePanels.length > 0 ? (
					<div
						className="flex min-h-0 flex-1 items-center justify-center px-4 text-xs text-muted-foreground"
						aria-busy="true"
					>
						Preparing workspace…
					</div>
				) : null}
				{ctx.status !== "worktree-pending" &&
					visiblePanels
						.filter((panel) => panel.kind !== "browser")
						.map((panel) => (
							<div
								key={panel.id}
								hidden={panel.id !== effectiveActiveId}
								className="flex min-h-0 min-w-0 flex-1 flex-col"
							>
								<PanelBody
									panel={panel}
									folderId={executionFolderId ?? selected.id}
									projectId={selected.id}
									environmentId={
										executionRef?.environmentId ??
										chatRef?.environmentId ??
										catalogEnvironmentId
									}
									chatRef={chatRef}
									rootPath={executionRootPath ?? selected.path}
									worktreeId={worktreeId}
									cloudUnavailable={ctx.status === "cloud-unavailable"}
									sessionId={sessionId}
									planMarkdown={planMarkdown}
									directoryUnavailable={directoryUnavailable}
								/>
							</div>
						))}
				{/* One host owns the command stream and keeps a webview mounted for
            every chat with a Browser panel. Only the selected chat is visible;
            background chats retain history and receive only their commands. */}
				{browserAvailable && ctx.status !== "cloud-unavailable" ? (
					<Suspense
						fallback={<div className="min-h-0 flex-1" aria-busy="true" />}
					>
						<BrowserPaneHost
							activeChatRef={chatRef}
							browserActive={browserActive}
						/>
					</Suspense>
				) : (
					<div
						hidden={!browserActive}
						className="flex min-h-0 min-w-0 flex-1 flex-col"
					>
						<div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
							<div className="max-w-sm">
								<h2 className="font-medium text-sm">
									Integrated browser is desktop-only
								</h2>
								<p className="mt-2 text-muted-foreground text-sm leading-6">
									Browser automation requires Electron’s isolated Chromium
									controls. Links can still open in a normal browser tab.
								</p>
							</div>
						</div>
					</div>
				)}
			</div>
		</aside>
	);
}

function PanelBody({
	panel,
	folderId,
	projectId,
	environmentId,
	chatRef,
	rootPath,
	worktreeId,
	sessionId,
	planMarkdown,
	directoryUnavailable,
	cloudUnavailable,
}: {
	panel: PanelInstance;
	folderId: FolderId;
	projectId: FolderId;
	environmentId: EnvironmentId;
	chatRef: ChatRef | null;
	rootPath: string;
	worktreeId: WorktreeId | null;
	sessionId: import("@zuse/contracts").SessionId | null;
	planMarkdown: string | null;
	directoryUnavailable: boolean;
	cloudUnavailable: boolean;
}) {
	if (cloudUnavailable && LIVE_PANEL_KINDS.has(panel.kind)) {
		return (
			<div
				role="status"
				className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground"
			>
				This cloud workspace is disconnected. Select this tab to reconnect.
			</div>
		);
	}
	if (
		directoryUnavailable &&
		(panel.kind === "files" ||
			panel.kind === "terminal" ||
			panel.kind === "changes")
	) {
		return (
			<div
				role="status"
				className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground"
			>
				This directory is unavailable.
			</div>
		);
	}
	switch (panel.kind) {
		case "files":
			return (
				<div className="min-h-0 flex-1 overflow-hidden">
					<FileTree
						key={folderId}
						folderId={folderId}
						projectId={projectId}
						environmentId={environmentId}
						rootPath={rootPath}
						worktreeId={worktreeId}
					/>
				</div>
			);
		case "terminal":
			return chatRef === null ? null : (
				<TerminalSlotPane
					chatRef={chatRef}
					rootPath={rootPath}
					slot={panel.slot}
				/>
			);
		case "changes":
			return (
				<DiffPane
					executionRef={{ environmentId, folderId, worktreeId, rootPath }}
				/>
			);
		case "pr":
			return (
				<PrPane
					executionRef={{ environmentId, folderId, worktreeId, rootPath }}
				/>
			);
		case "plan":
			return <PlanPane markdown={planMarkdown} />;
		case "browser":
			// Browser is rendered once, always-mounted, by RightPane (so the agent
			// command stream survives close/collapse) — never via this map.
			return null;
		case "subagents":
			return <SubagentsPane chatRef={chatRef} sessionId={sessionId} />;
	}
}

function PlanPane({ markdown }: { readonly markdown: string | null }) {
	if (markdown === null) return null;
	return (
		<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
			<MarkdownBody className="mx-auto max-w-3xl">{markdown}</MarkdownBody>
		</div>
	);
}

/**
 * Empty-state launcher: a vertically-centered list of every addable panel as
 * a large row (icon + label + shortcut). Shown when the sidebar is open but
 * no panels have been added yet.
 */
function PanelLauncher({
	actions,
	addable,
	onAdd,
}: {
	actions: React.ReactNode;
	addable: ReadonlyArray<PanelKind>;
	onAdd: (kind: PanelKind) => void;
}) {
	return (
		<div className="relative flex min-h-0 flex-1 flex-col items-center justify-center px-3">
			<div className="absolute right-3 top-3">{actions}</div>
			<div className="flex w-full max-w-md flex-col gap-1.5">
				{addable.map((kind) => {
					const meta = PANEL_META[kind];
					return (
						<button
							key={kind}
							type="button"
							onClick={() => onAdd(kind)}
							className="flex w-full items-center gap-3 rounded-lg bg-card/80 px-3 py-3 text-left text-sm text-foreground/90 transition-colors hover:bg-card/60"
						>
							<HugeiconsIcon
								icon={meta.icon}
								className="size-4 shrink-0 text-muted-foreground"
							/>
							<span className="flex-1 truncate">{meta.label}</span>
							{meta.shortcut !== undefined && meta.shortcut !== "" ? (
								<kbd className="font-sans text-[11px] text-muted-foreground/70">
									{meta.shortcut}
								</kbd>
							) : null}
						</button>
					);
				})}
			</div>
		</div>
	);
}

/** Trailing "+" in the tab strip. Lists the kinds the user can still add. */
function AddPanelMenu({
	addable,
	onAdd,
}: {
	addable: ReadonlyArray<PanelKind>;
	onAdd: (kind: PanelKind) => void;
}) {
	if (addable.length === 0) return null;
	return (
		<Menu>
			<Tooltip>
				<TooltipTrigger
					render={
						<MenuTrigger
							className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground data-[popup-open]:bg-muted/60"
							aria-label="Add panel"
						>
							<Plus className="size-3.5" strokeWidth={1.8} />
						</MenuTrigger>
					}
				/>
				<TooltipPopup>Add panel</TooltipPopup>
			</Tooltip>
			<MenuPopup align="end" className="w-72 p-1">
				{addable.length > 0
					? addable.map((kind) => {
							const meta = PANEL_META[kind];
							return (
								<MenuItem
									key={kind}
									onClick={() => onAdd(kind)}
									className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-sm hover:bg-sidebar-accent"
								>
									<HugeiconsIcon
										icon={meta.icon}
										className="size-3.5 opacity-80"
									/>
									<span className="min-w-0 flex-1 truncate">{meta.label}</span>
									{meta.shortcut !== undefined && meta.shortcut !== "" ? (
										<MenuShortcut>{meta.shortcut}</MenuShortcut>
									) : null}
								</MenuItem>
							);
						})
					: null}
			</MenuPopup>
		</Menu>
	);
}

function PanelTab({
	active,
	icon,
	label,
	badge,
	onSelect,
	onClose,
}: {
	active: boolean;
	icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
	label: string;
	badge?: React.ReactNode;
	onSelect: () => void;
	onClose: () => void;
}) {
	return (
		<div
			className={`group flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] transition-colors ${
				active
					? "bg-muted text-foreground"
					: "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
			}`}
		>
			<button
				type="button"
				onClick={onSelect}
				className="flex max-w-36 items-center gap-1.5"
			>
				<HugeiconsIcon icon={icon} className="size-3.5 shrink-0 opacity-80" />
				<span className="truncate">{label}</span>
				{badge}
			</button>
			<button
				type="button"
				aria-label={`Close ${label}`}
				onClick={(e) => {
					e.stopPropagation();
					onClose();
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						e.stopPropagation();
						onClose();
					}
				}}
				className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100"
			>
				<X className="size-3" strokeWidth={1.8} />
			</button>
		</div>
	);
}

function renderChangesBadge(dirtyFiles: number): React.ReactNode {
	if (dirtyFiles === 0) return null;
	return (
		<span className="flex min-w-[1rem] items-center justify-center rounded-full bg-amber-400/20 px-1 font-mono text-[10px] text-amber-200">
			{dirtyFiles}
		</span>
	);
}

function renderPrBadge(
	pr: {
		state: string;
		isDraft: boolean;
		checks: string;
		mergeable: string;
	} | null,
	details: {
		comments: ReadonlyArray<unknown>;
		reviews: ReadonlyArray<unknown>;
		checkRuns: ReadonlyArray<{ conclusion: string | null; status: string }>;
	} | null,
): React.ReactNode {
	if (pr === null || pr.state === "none") return null;
	if (pr.state === "open" && !pr.isDraft) {
		if (pr.mergeable === "conflicting") {
			return (
				<span
					className="flex items-center text-rose-300"
					title="Merge conflicts"
				>
					<span className="size-2 rounded-full bg-rose-400" />
				</span>
			);
		}
		if (pr.checks === "failure") {
			const failing =
				details === null
					? null
					: details.checkRuns.filter(
							(c) =>
								c.conclusion === "failure" ||
								c.conclusion === "cancelled" ||
								c.conclusion === "timed_out" ||
								c.conclusion === "action_required",
						).length;
			return (
				<span className="flex items-center gap-1 text-rose-300">
					<span className="size-2 rounded-full border border-rose-300" />
					{failing !== null && failing > 0 ? (
						<span className="font-mono text-[10px]">{failing}</span>
					) : null}
				</span>
			);
		}
	}
	if (details === null) return null;
	const count = details.comments.length + details.reviews.length;
	if (count === 0) return null;
	return (
		<span className="flex min-w-[1rem] items-center justify-center rounded-full bg-muted px-1 font-mono text-[10px] text-foreground">
			{count}
		</span>
	);
}
