import { formatNumber as formatUiNumber } from "@zuse/i18n";
import { useGitPrState } from "../lib/use-git-pr-state.ts";
import { GitStackMenu } from "./git-stack-menu.tsx";
import { PrActionsMenu } from "./pr-actions-menu.tsx";
import { PrAutoFix } from "./pr-auto-fix.tsx";
import { PrChecksPreview } from "./pr-checks-preview.tsx";
import { Spinner } from "./ui/spinner.tsx";
import "@zuse/i18n/english/chat";
import { HugeiconsIcon } from "@hugeicons/react";
import type { GitBranchInfo, Message } from "@zuse/contracts";
import { CommandId } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	Alert01Icon,
	ArrowLeftRightIcon,
	CheckListIcon,
	ComputerPhoneSyncIcon,
	GitCompareIcon,
	GitMergeIcon,
	GitPullRequestIcon,
	LaptopIcon,
	Loading02Icon,
	ServerStack01Icon,
	Tick02Icon,
} from "@zuse/icons/stroke-rounded";
import { latestProposedPlanMarkdown } from "@zuse/utils/proposed-plan";

import { useEffect, useMemo, useRef, useState } from "react";

import { deriveEnvironmentPrRows } from "../lib/branch-workflow.ts";
import { useCloudChatCatalogStore } from "../lib/cloud-workspace-catalog.ts";
import { displayPath } from "../lib/display-path.ts";
import { useActiveSessionById } from "../lib/environment-entity-hooks.ts";
import { deriveEnvironmentLocation } from "../lib/environment-location.ts";
import { formatError } from "../lib/format-error.ts";
import {
	dispatchGitWorkspaceCommand,
	refreshGitPrDetails,
	refreshGitWorkspace,
} from "../lib/git-workspace-client-bus.ts";
import { detachedSubagentGroups } from "../lib/group-messages.ts";
import { getLocalEnvironmentId } from "../lib/rpc-client.ts";
import { sendSessionMessage } from "../lib/session-actions.ts";
import { isSessionTurnActive } from "../lib/session-runtime-state.ts";
import { useOptionalRendererSessionTimeline } from "../lib/session-timeline-hooks.ts";
import { useActiveContext } from "../store/active-workspace.ts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { EMPTY_WORKTREES, useWorktreesStore } from "../store/worktrees.ts";
import {
	CloudWorkspaceInfo,
	summaryRowClass as rowClass,
} from "./cloud-workspace-info.tsx";
import { SubagentAvatar } from "./subagent-identity.tsx";
import { BranchMenuButton, ResolveConflictsButton } from "./top-bar.tsx";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuTrigger,
} from "./ui/menu.tsx";
import {
	PreviewCard,
	PreviewCardPopup,
	PreviewCardTrigger,
} from "./ui/preview-card.tsx";

const compactNumber = (value: number): string =>
	formatUiNumber(value, { notation: "compact" });

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

export function EnvironmentSummary() {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	const ctx = useActiveContext();
	const folderId = ctx.status === "ready" ? ctx.folderId : null;
	const worktreeId = ctx.status === "ready" ? ctx.worktreeId : null;
	const activeEnvironmentId = useEnvironmentCatalogStore(
		(state) => state.activeEnvironmentId,
	);
	const activeEnvironmentEntry = useEnvironmentCatalogStore(
		(state) =>
			state.entries.find(
				(entry) => entry.environmentId === state.activeEnvironmentId,
			) ?? null,
	);
	const environmentLocation = deriveEnvironmentLocation({
		activeEnvironmentId,
		localEnvironmentId: getLocalEnvironmentId(),
		activeEntry: activeEnvironmentEntry,
	});
	const EnvironmentIcon = environmentLocation.isLocal
		? LaptopIcon
		: ServerStack01Icon;
	const executionRef =
		ctx.status === "ready"
			? {
					environmentId: ctx.environmentId,
					folderId: ctx.folderId,
					worktreeId: ctx.worktreeId,
					rootPath: ctx.rootPath,
				}
			: null;
	const environmentId = executionRef?.environmentId ?? null;
	const cloudWorkspaceId = useCloudChatCatalogStore((state) =>
		environmentId !== null &&
		state.summaries.some((candidate) => candidate.workspaceId === environmentId)
			? environmentId
			: null,
	);
	const [checksOpen, setChecksOpen] = useState(false);
	const suppressChecksPreview = useRef(false);
	const [checksRequestedKey, setChecksRequestedKey] = useState<string | null>(
		null,
	);
	const {
		gitView,
		prDetailsView,
		pr,
		details: prDetails,
		checkRuns,
	} = useGitPrState(executionRef, checksRequestedKey !== null);
	const status = gitView.data?.status ?? null;
	const diffStat = gitView.data?.diffStat ?? null;
	const [branches, setBranches] = useState<ReadonlyArray<GitBranchInfo>>([]);
	const [branchesLoading, setBranchesLoading] = useState(false);
	const [branchError, setBranchError] = useState<string | null>(null);

	const prDetailsLoading = prDetailsView.sync === "synchronizing";
	const revealPanelForChat = useUiStore((s) => s.revealPanelForChat);
	const selectSubagent = useUiStore((s) => s.selectSubagent);
	const sessionId = useSessionsStore((s) => s.selectedSessionId);
	const session = useActiveSessionById(sessionId);
	const chatRef =
		environmentId === null || session === null
			? null
			: { environmentId, chatId: session.chatId };
	const revealPanel = (kind: Parameters<typeof revealPanelForChat>[1]) => {
		if (chatRef !== null) revealPanelForChat(chatRef, kind);
	};
	const timeline = useOptionalRendererSessionTimeline(
		sessionId,
		"connect",
		environmentId,
	);
	const messages = timeline.messages;
	const isRunning = session !== null && isSessionTurnActive(timeline.runtime);
	const planAvailable = useMemo(
		() =>
			latestProposedPlanMarkdown(messages) !== null ||
			(session?.providerId === "codex" &&
				session.permissionMode === "plan" &&
				!isRunning &&
				latestAssistantText(messages) !== null),
		[
			isRunning,
			messages,
			session?.permissionMode,
			session?.providerId,
			uiMessage,
		],
	);
	const subagents = useMemo(
		() => detachedSubagentGroups(messages),
		[messages, uiMessage],
	);
	const activeSubagents = subagents.filter(
		(group) => group.summary === null,
	).length;
	const worktree = useWorktreesStore((s) => {
		if (ctx.status !== "ready" || ctx.worktreeId === null) return null;
		return (
			(s.byProject[ctx.folderId] ?? EMPTY_WORKTREES).find(
				(item) => item.id === ctx.worktreeId,
			) ?? null
		);
	});
	const branchLabel = status?.branch ?? worktree?.branch ?? "Loading branch…";
	const refreshBranches = async (): Promise<void> => {
		if (executionRef === null || folderId === null) return;
		setBranchesLoading(true);
		setBranchError(null);
		try {
			const { result } = await dispatchGitWorkspaceCommand<
				{
					readonly folderId: typeof folderId;
					readonly worktreeId: typeof worktreeId;
				},
				ReadonlyArray<GitBranchInfo>
			>({
				ref: executionRef,
				kind: "git.branches",
				commandId: CommandId.make(`git-branches:${crypto.randomUUID()}`),
				payload: { folderId, worktreeId },
			});
			setBranches(result);
		} catch (error) {
			setBranchError(formatError(error));
		} finally {
			setBranchesLoading(false);
		}
	};
	useEffect(() => {
		void refreshBranches();
		// The active branch is the refresh boundary for this menu.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [branchLabel, environmentId, folderId, worktreeId]);
	const switchToBranch = async (branch: GitBranchInfo): Promise<void> => {
		if (executionRef === null || folderId === null || branch.current) return;
		if (
			(status?.dirtyFiles ?? 0) > 0 &&
			!window.confirm(
				`Switch branches with ${status?.dirtyFiles ?? 0} uncommitted changes? Git may refuse if they conflict.`,
			)
		)
			return;
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
		} catch (error) {
			setBranchError(formatError(error));
		} finally {
			setBranchesLoading(false);
		}
	};
	const openDevices = () => {
		const ui = useUiStore.getState();
		ui.setSettingsSection({ kind: "devices" });
		ui.setView("settings");
	};

	if (ctx.status !== "ready") return null;

	const changesLabel =
		status === null
			? "Changes"
			: status.dirtyFiles === 0
				? "No changes"
				: `${status.dirtyFiles} change${status.dirtyFiles === 1 ? "" : "s"}`;
	const prLabel =
		pr === null
			? "Loading pull request…"
			: pr.state === "none"
				? "Pull request"
				: `PR #${pr.number ?? "?"} · ${pr.state}`;
	const prRows = deriveEnvironmentPrRows(pr);
	const prStatus = (() => {
		if (pr === null) {
			return {
				icon: Loading02Icon,
				label: uiMessage("chat:environment_summary_loading_pull_request"),
				className: "animate-spin text-muted-foreground",
			};
		}
		if (pr.state === "merged") {
			return {
				icon: GitMergeIcon,
				label: uiMessage("chat:environment_summary_pull_request_merged"),
				className: "text-primary",
			};
		}
		if (pr.state === "closed") {
			return {
				icon: Alert01Icon,
				label: uiMessage("chat:environment_summary_pull_request_closed"),
				className: "text-muted-foreground",
			};
		}
		if (pr.state === "open") {
			return {
				icon: Tick02Icon,
				label: uiMessage("chat:environment_summary_pull_request_open"),
				className: "text-[var(--accent-green)]",
			};
		}
		return {
			icon: GitPullRequestIcon,
			label: uiMessage("chat:environment_summary_no_pull_request"),
			className: "text-muted-foreground",
		};
	})();
	const openPullRequest = () => {
		if (pr?.state === "none" && sessionId !== null && environmentId !== null) {
			void sendSessionMessage(
				{ environmentId, sessionId },
				"create a pull request for this branch",
				{ providerId: session?.providerId },
			);
			return;
		}
		revealPanel("pr");
	};
	const hydrateChecks = (open: boolean) => {
		if (!open || executionRef === null) return;
		const key = `${executionRef.environmentId}:${executionRef.folderId}:${executionRef.worktreeId ?? "main"}`;
		setChecksRequestedKey(key);
		if (prDetails === null && !prDetailsLoading)
			void refreshGitPrDetails(executionRef);
	};

	return (
		<aside
			aria-label={uiMessage("chat:environment_summary_environment_summary")}
			className="pointer-events-auto max-h-[calc(100dvh-7rem)] w-64 shrink-0 overflow-y-auto rounded-lg bg-glass border-glass p-1"
		>
			<h2 className="px-2 pb-1 pt-0.5 text-xs font-medium text-muted-foreground">
				{uiMessage("chat:environment_summary_summary")}
			</h2>
			<button
				type="button"
				className={`${rowClass} hover:bg-muted/60`}
				onClick={() => revealPanel("changes")}
			>
				<HugeiconsIcon icon={GitCompareIcon} className="size-4 shrink-0" />
				<span className="min-w-0 flex-1 truncate">{changesLabel}</span>
				{diffStat !== null ? (
					<span className="flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums">
						<span className="text-[var(--accent-green)]">
							+{compactNumber(diffStat.additions)}
						</span>
						<span className="text-[var(--accent-red)]">
							−{compactNumber(diffStat.deletions)}
						</span>
					</span>
				) : null}
			</button>
			<Menu modal={false}>
				<MenuTrigger
					className={`${rowClass} hover:bg-muted/60 data-[popup-open]:bg-muted/60`}
					title={`${environmentLocation.menuLabel} · ${displayPath(ctx.rootPath)}`}
				>
					<HugeiconsIcon
						icon={EnvironmentIcon}
						className="size-4 shrink-0 text-muted-foreground"
					/>
					<span className="min-w-0 flex-1 truncate">
						{environmentLocation.label}
					</span>
					<span className="size-1.5 rounded-full bg-[var(--accent-green)]" />
				</MenuTrigger>
				<MenuPopup side="left" align="start" sideOffset={8} className="w-60">
					<div className="px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
						{uiMessage("chat:environment_summary_running_on")}
					</div>
					<MenuItem className="h-7 gap-2 px-2 py-0 text-xs">
						<HugeiconsIcon icon={EnvironmentIcon} className="size-4" />
						<span className="flex-1">{environmentLocation.menuLabel}</span>
						<span className="text-[11px] text-[var(--accent-green)]">
							{uiMessage("chat:environment_summary_active")}
						</span>
					</MenuItem>
					<MenuSeparator />
					<MenuItem
						onClick={openDevices}
						className="h-7 gap-2 px-2 py-0 text-xs"
					>
						<HugeiconsIcon icon={ComputerPhoneSyncIcon} className="size-4" />
						<span className="flex-1">
							{uiMessage("chat:environment_summary_connected_devices")}
						</span>
					</MenuItem>
					<MenuItem
						onClick={openDevices}
						className="h-7 gap-2 px-2 py-0 text-xs"
					>
						<HugeiconsIcon icon={ArrowLeftRightIcon} className="size-4" />
						<span className="flex-1">
							{uiMessage("chat:environment_summary_worktree_handoff")}
						</span>
					</MenuItem>
				</MenuPopup>
			</Menu>
			{cloudWorkspaceId !== null ? (
				<CloudWorkspaceInfo workspaceId={cloudWorkspaceId} />
			) : null}
			<BranchMenuButton
				branchLabel={branchLabel}
				branches={branches}
				canRename={false}
				className={`${rowClass} max-w-none justify-start hover:bg-muted/60 data-[popup-open]:bg-muted/60`}
				popupSide="left"
				dirtyFiles={status?.dirtyFiles ?? 0}
				error={branchError}
				loading={branchesLoading}
				onOpen={() => void refreshBranches()}
				onRename={() => {}}
				onSwitch={(branch) => void switchToBranch(branch)}
			/>
			{executionRef ? (
				<GitStackMenu
					branch={status?.branch ?? null}
					key={`${executionRef.environmentId}:${executionRef.folderId}:${executionRef.worktreeId}:${status?.branch}`}
					executionRef={executionRef}
					className={`${rowClass} hover:bg-muted/60`}
				/>
			) : null}
			{pr && pr.state !== "none" && executionRef ? (
				<PrActionsMenu
					executionRef={executionRef}
					pr={pr}
					details={prDetails}
					sessionId={sessionId}
					busy={isRunning}
					className={`${rowClass} hover:bg-muted/60`}
					onView={() => revealPanel("pr")}
					onChat={() => {
						suppressChecksPreview.current = true;
						setChecksOpen(false);
						useUiStore.getState().setActiveMainTab("chat");
					}}
				/>
			) : (
				<button
					type="button"
					className={`${rowClass} justify-between hover:bg-muted/60`}
					onClick={openPullRequest}
				>
					<HugeiconsIcon
						icon={prStatus.icon}
						className={`size-4 shrink-0 ${prStatus.className}`}
						aria-label={prStatus.label}
					/>
					<span className="min-w-0 flex-1 truncate">{prLabel}</span>
					<span className="shrink-0 text-[10px] text-muted-foreground">
						{pr?.state === "none"
							? uiMessage("chat:environment_summary_create_pr")
							: uiMessage("common:open")}
					</span>
				</button>
			)}
			{prRows.checks !== null ? (
				<div className={`${rowClass} justify-between`}>
					<PreviewCard
						open={checksOpen}
						onOpenChange={(open) => {
							if (open && suppressChecksPreview.current) return;
							setChecksOpen(open);
							hydrateChecks(open);
						}}
					>
						<PreviewCardTrigger
							onPointerMove={() => {
								suppressChecksPreview.current = false;
							}}
							onPointerLeave={() => {
								suppressChecksPreview.current = false;
							}}
							onFocus={() => {
								suppressChecksPreview.current = false;
							}}
							delay={100}
							render={
								<button
									type="button"
									className="flex min-h-7 min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
									onClick={() => revealPanel("pr")}
								>
									<ChecksStatusIcon kind={prRows.checks.kind} />
									<span className="min-w-0 flex-1 truncate">
										{uiMessage("chat:environment_summary_github_actions")}
									</span>
									<span className="shrink-0 text-[10px] text-muted-foreground">
										{prRows.checks.label}
									</span>
								</button>
							}
						/>
						<PreviewCardPopup
							side="left"
							align="center"
							sideOffset={8}
							className="w-64 p-1"
						>
							<PrChecksPreview
								checks={checkRuns}
								loading={prDetailsLoading && checkRuns === null}
								action={
									pr && executionRef ? (
										<PrAutoFix
											executionRef={executionRef}
											pr={pr}
											sessionId={sessionId}
										/>
									) : null
								}
							/>
						</PreviewCardPopup>
					</PreviewCard>
				</div>
			) : null}
			{prRows.conflicts ? (
				<div className={`${rowClass} justify-between`}>
					<button
						type="button"
						className="flex min-h-7 min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
						onClick={() => revealPanel("pr")}
					>
						<HugeiconsIcon
							icon={Alert01Icon}
							className="size-4 shrink-0 text-[var(--accent-red)]"
						/>
						<span className="min-w-0 flex-1 truncate">
							{uiMessage("chat:environment_summary_merge_conflicts")}
						</span>
					</button>
					<span className="pointer-events-none shrink-0 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 motion-reduce:transition-none">
						<ResolveConflictsButton presentation="inline" />
					</span>
				</div>
			) : null}
			{planAvailable ? (
				<>
					<div className="mx-2 my-1 border-border/60 border-t" />
					<button
						type="button"
						className={`${rowClass} hover:bg-muted/60`}
						onClick={() => revealPanel("plan")}
					>
						<HugeiconsIcon
							icon={CheckListIcon}
							className="size-4 shrink-0 text-primary"
						/>
						<span className="min-w-0 flex-1 truncate">
							{uiMessage("chat:environment_summary_plan")}
						</span>
					</button>
				</>
			) : null}
			{subagents.length > 0 ? (
				<section className="mx-2 mt-2 border-border/70 border-t px-0.5 pb-1 pt-3">
					<h3 className="mb-2 text-xs font-medium text-muted-foreground">
						{uiMessage("chat:environment_summary_subagents")}
					</h3>
					<button
						type="button"
						className="flex min-h-9 w-full items-center gap-2 rounded-lg px-1.5 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/60"
						onClick={() => {
							if (chatRef !== null) selectSubagent(chatRef, null);
							revealPanel("subagents");
						}}
					>
						<span className="flex shrink-0 items-center gap-1">
							{subagents.slice(0, 4).map((group) => (
								<SubagentAvatar
									key={group.childSessionId}
									name={group.agentName}
									size="sm"
								/>
							))}
						</span>
						<span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
							{activeSubagents > 0
								? uiMessage("chat:environment_summary_active_2", {
										activeSubagents: String(activeSubagents),
									})
								: uiMessage("chat:environment_summary_done", {
										value1: String(subagents.length),
									})}
						</span>
					</button>
				</section>
			) : null}
		</aside>
	);
}

function ChecksStatusIcon({
	kind,
}: {
	kind: "pending" | "failure" | "success";
}) {
	if (kind === "pending") {
		return (
			<Spinner className="size-[15px] shrink-0 text-[var(--accent-amber)]" />
		);
	}
	if (kind === "failure") {
		return (
			<HugeiconsIcon
				icon={Alert01Icon}
				className="size-4 shrink-0 text-[var(--accent-red)]"
			/>
		);
	}
	return (
		<HugeiconsIcon
			icon={Tick02Icon}
			className="size-4 shrink-0 text-[var(--accent-green)]"
		/>
	);
}
