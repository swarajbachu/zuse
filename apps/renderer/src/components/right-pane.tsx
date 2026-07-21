import { HugeiconsIcon } from "@hugeicons/react";
import {
	CheckListIcon,
	ComputerTerminal01Icon,
	Folder01Icon,
	GitBranchIcon,
	GitCompareIcon,
	GitPullRequestIcon,
	GlobeIcon,
	MagicWand01Icon,
} from "@hugeicons-pro/core-solid-rounded";
import type { FolderId, Message, WorktreeId } from "@zuse/contracts";
import { latestProposedPlanMarkdown } from "@zuse/utils/proposed-plan";
import { Plus, X } from "lucide-react";
import { useMemo, useRef, useSyncExternalStore } from "react";
import { formatShortcut } from "../lib/shortcuts.ts";
import * as terminalRegistry from "../lib/terminal-registry.ts";
import { useAutoAnimate } from "../lib/use-auto-animate.ts";
import { useActiveContext } from "../store/active-workspace.ts";
import { useChatsStore } from "../store/chats.ts";
import { gitStatusKey, useGitStatusStore } from "../store/git-status.ts";
import { useMessagesStore } from "../store/messages.ts";
import { useRegisterPane } from "../store/pane-focus.ts";
import { prDetailsKey, usePrDetailsStore } from "../store/pr-details.ts";
import { prStateKey, usePrStateStore } from "../store/pr-state.ts";
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
	SINGLETON_PANEL_KINDS,
	useUiStore,
} from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { EMPTY_WORKTREES, useWorktreesStore } from "../store/worktrees.ts";
import { BrowserPane } from "./browser-pane.tsx";
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

/** Primary surfaces shown in the empty launcher and standard add menu. */
const PRIMARY_PANEL_ORDER: ReadonlyArray<PanelKind> = [
	"files",
	"pr",
	"changes",
	"terminal",
	"browser",
];

const EMPTY_MESSAGES: ReadonlyArray<Message> = [];

const latestAssistantText = (
	messages: ReadonlyArray<Message>,
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
	const selectedFolderId = ctx.status === "ready" ? ctx.folderId : null;
	const worktreeId = ctx.status === "ready" ? ctx.worktreeId : null;
	const selected = selectedFolderId
		? (folders.find((f) => f.id === selectedFolderId) ?? null)
		: null;
	const status = useGitStatusStore((s) =>
		selectedFolderId
			? (s.byKey[gitStatusKey(selectedFolderId, worktreeId)] ?? null)
			: null,
	);
	const pr = usePrStateStore((s) =>
		selectedFolderId
			? (s.byKey[prStateKey(selectedFolderId, worktreeId)] ?? null)
			: null,
	);
	const details = usePrDetailsStore((s) =>
		selectedFolderId
			? (s.byKey[prDetailsKey(selectedFolderId, worktreeId)] ?? null)
			: null,
	);
	// Dock layout + terminals are scoped to the selected sidebar chat, so each
	// chat keeps its own open tabs and running shells.
	const chatId = useChatsStore((s) => s.selectedChatId);
	const sessionId = useSessionsStore((s) => s.selectedSessionId);
	const session = useSessionsStore((s) => {
		if (sessionId === null) return null;
		for (const list of Object.values(s.sessionsByProject)) {
			const match = list.find((candidate) => candidate.id === sessionId);
			if (match !== undefined) return match;
		}
		return null;
	});
	const messages = useMessagesStore((s) =>
		sessionId === null
			? EMPTY_MESSAGES
			: (s.messagesBySession[sessionId] ?? EMPTY_MESSAGES),
	);
	const isRunning = useMessagesStore((s) =>
		sessionId === null ? false : s.runningBySession[sessionId] === true,
	);
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
		chatId
			? (s.byKey[terminalsKey(chatId)] ?? EMPTY_TERMINALS)
			: EMPTY_TERMINALS,
	);
	const terminalStatuses = useSyncExternalStore(
		terminalRegistry.subscribeStatuses,
		terminalRegistry.getStatusesSnapshot,
		terminalRegistry.getStatusesSnapshot,
	);

	const panels = useUiStore((s) =>
		chatId ? (s.rightPanelsByChat[chatId] ?? EMPTY_PANELS) : EMPTY_PANELS,
	);
	const activeId = useUiStore((s) =>
		chatId ? (s.activeRightPanelByChat[chatId] ?? null) : null,
	);
	const addPanel = useUiStore((s) => s.addPanel);
	const closePanel = useUiStore((s) => s.closePanel);
	const setActive = useUiStore((s) => s.setActiveRightPanel);
	const openChanges = useUiStore((s) => s.openChanges);
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
		if (panel.kind === "terminal" && chatId !== null) {
			const key = terminalsKey(chatId);
			const inst = (useTerminalsStore.getState().byKey[key] ?? EMPTY_TERMINALS)[
				panel.slot
			];
			if (inst !== undefined) {
				useTerminalsStore.getState().remove(key, inst.id);
			}
		}
		closePanel(panel.id);
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
				instance !== undefined && terminalStatuses[instance.id] === "failed";
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
	const addPanelMenu = (
		<AddPanelMenu addable={addablePanels} onAdd={addPanel} />
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
					className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto px-1 text-xs"
				>
					{visiblePanels.map((panel) => (
						<PanelTab
							key={panel.id}
							active={panel.id === effectiveActiveId}
							icon={PANEL_META[panel.kind].icon}
							label={tabLabel(panel)}
							badge={tabBadge(panel)}
							onSelect={() => {
								setActive(panel.id);
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
						onAdd={addPanel}
					/>
				) : null}
				{/* Non-browser panels: mount on add, kept mounted while open. */}
				{visiblePanels
					.filter((panel) => panel.kind !== "browser")
					.map((panel) => (
						<div
							key={panel.id}
							hidden={panel.id !== effectiveActiveId}
							className="flex min-h-0 min-w-0 flex-1 flex-col"
						>
							<PanelBody
								panel={panel}
								folderId={selected.id}
								worktreeId={worktreeId}
								sessionId={sessionId}
								planMarkdown={planMarkdown}
								directoryUnavailable={directoryUnavailable}
							/>
						</div>
					))}
				{/* Browser is always mounted (display:none when not the active tab)
            so the agent `browser.commands` stream stays alive even with no
            browser tab open or the sidebar collapsed — a command then calls
            revealPanel("browser") to surface it. Mounting it only on add
            would drop commands issued while it's closed. */}
				<div
					hidden={!browserActive}
					className="flex min-h-0 min-w-0 flex-1 flex-col"
				>
					<BrowserPane />
				</div>
			</div>
		</aside>
	);
}

function PanelBody({
	panel,
	folderId,
	worktreeId,
	sessionId,
	planMarkdown,
	directoryUnavailable,
}: {
	panel: PanelInstance;
	folderId: FolderId;
	worktreeId: WorktreeId | null;
	sessionId: import("@zuse/contracts").SessionId | null;
	planMarkdown: string | null;
	directoryUnavailable: boolean;
}) {
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
					<FileTree key={folderId} folderId={folderId} />
				</div>
			);
		case "terminal":
			return <TerminalSlotPane slot={panel.slot} />;
		case "changes":
			return <DiffPane folderId={folderId} worktreeId={worktreeId} />;
		case "pr":
			return <PrPane folderId={folderId} worktreeId={worktreeId} />;
		case "plan":
			return <PlanPane markdown={planMarkdown} />;
		case "browser":
			// Browser is rendered once, always-mounted, by RightPane (so the agent
			// command stream survives close/collapse) — never via this map.
			return null;
		case "subagents":
			return <SubagentsPane sessionId={sessionId} />;
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

/**
 * Strip above the file tree showing whether the current selection is rooted
 * in the project's main checkout or in a worktree. Read-only label — pick a
 * worktree from the chat composer's workspace picker; this chip just makes
 * the active root visible so users don't get confused by what they're
 * looking at. Reads the canonical active context so it can never disagree
 * with the terminal, top-bar branch, or composer chip.
 */
function ActiveWorkspaceChip() {
	const ctx = useActiveContext();
	const worktree = useWorktreesStore((s) => {
		if (ctx.status !== "ready" || ctx.worktreeId === null) return null;
		const list = s.byProject[ctx.folderId] ?? EMPTY_WORKTREES;
		return list.find((w) => w.id === ctx.worktreeId) ?? null;
	});
	if (ctx.status !== "ready") return null;
	const onWorktree = ctx.rootKind === "worktree";
	const icon = onWorktree ? GitBranchIcon : Folder01Icon;
	const label = onWorktree ? (worktree?.name ?? "Worktree") : "Main checkout";
	const sub = onWorktree ? (worktree?.branch ?? null) : null;
	return (
		<div className="flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-[11px] text-muted-foreground">
			<HugeiconsIcon icon={icon} className="size-3.5 shrink-0 opacity-70" />
			<span className="truncate font-medium text-foreground/80">{label}</span>
			{sub !== null ? (
				<span className="truncate font-mono opacity-70">· {sub}</span>
			) : null}
			{ctx.worktreePending ? (
				<span className="shrink-0 text-amber-300">syncing…</span>
			) : null}
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
