import { HugeiconsIcon } from "@hugeicons/react";
import type { GitBranchInfo, GitPrCheckRun, Message } from "@zuse/contracts";
import { CommandId } from "@zuse/contracts";
import {
	Alert01Icon,
	CheckListIcon,
	Clock01Icon,
	GitCompareIcon,
	GitMergeIcon,
	GitPullRequestIcon,
	Loading02Icon,
	Tick02Icon,
} from "@zuse/icons/solid-rounded";
import { latestProposedPlanMarkdown } from "@zuse/utils/proposed-plan";
import {
	ArrowLeftRight,
	Laptop,
	MonitorSmartphone,
	Server,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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
	useGitPrDetailsResource,
	useGitWorkspaceResource,
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
import {
	BranchMenuButton,
	FixActionsButton,
	ResolveConflictsButton,
} from "./top-bar.tsx";
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
	new Intl.NumberFormat("en", { notation: "compact" }).format(value);

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
	const EnvironmentIcon = environmentLocation.isLocal ? Laptop : Server;
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
	const [checksRequestedKey, setChecksRequestedKey] = useState<string | null>(
		null,
	);
	const gitView = useGitWorkspaceResource(executionRef, "connect");
	const prDetailsView = useGitPrDetailsResource(
		executionRef,
		checksRequestedKey === null ? "cache-only" : "connect",
	);
	const status = gitView.data?.status ?? null;
	const diffStat = gitView.data?.diffStat ?? null;
	const [branches, setBranches] = useState<ReadonlyArray<GitBranchInfo>>([]);
	const [branchesLoading, setBranchesLoading] = useState(false);
	const [branchError, setBranchError] = useState<string | null>(null);
	const pr = gitView.data?.pr ?? null;
	const prDetails = prDetailsView.data?.details ?? null;
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
		[isRunning, messages, session?.permissionMode, session?.providerId],
	);
	const subagents = useMemo(() => detachedSubagentGroups(messages), [messages]);
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
				label: "Loading pull request",
				className: "animate-spin text-muted-foreground",
			};
		}
		if (pr.state === "merged") {
			return {
				icon: GitMergeIcon,
				label: "Pull request merged",
				className: "text-primary",
			};
		}
		if (pr.state === "closed") {
			return {
				icon: Alert01Icon,
				label: "Pull request closed",
				className: "text-muted-foreground",
			};
		}
		if (pr.state === "open") {
			return {
				icon: Tick02Icon,
				label: "Pull request open",
				className: "text-[var(--accent-green)]",
			};
		}
		return {
			icon: GitPullRequestIcon,
			label: "No pull request",
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
		void refreshGitPrDetails(executionRef);
	};

	return (
		<aside
			aria-label="Environment summary"
			className="pointer-events-auto max-h-[calc(100dvh-7rem)] w-64 shrink-0 overflow-y-auto rounded-3xl border border-border/70 bg-card/95 p-1 shadow-overlay-sm backdrop-blur-xl"
		>
			<h2 className="px-2 pb-1 pt-0.5 text-xs font-medium text-muted-foreground">
				Summary
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
			<Menu>
				<MenuTrigger
					className={`${rowClass} hover:bg-muted/60 data-[popup-open]:bg-muted/60`}
					title={`${environmentLocation.menuLabel} · ${displayPath(ctx.rootPath)}`}
				>
					<EnvironmentIcon className="size-4 shrink-0 text-muted-foreground" />
					<span className="min-w-0 flex-1 truncate">
						{environmentLocation.label}
					</span>
					<span className="size-1.5 rounded-full bg-[var(--accent-green)]" />
				</MenuTrigger>
				<MenuPopup
					side="left"
					align="start"
					sideOffset={8}
					className="min-w-72 rounded-2xl p-1.5"
				>
					<div className="px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
						Running on
					</div>
					<MenuItem className="gap-2.5 px-2.5 py-2 text-[13px]">
						<EnvironmentIcon className="size-4" />
						<span className="flex-1">{environmentLocation.menuLabel}</span>
						<span className="text-[11px] text-[var(--accent-green)]">
							Active
						</span>
					</MenuItem>
					<MenuSeparator />
					<MenuItem
						onClick={openDevices}
						className="gap-2.5 px-2.5 py-2 text-[13px]"
					>
						<MonitorSmartphone className="size-4" />
						<span className="flex-1">Connected devices</span>
					</MenuItem>
					<MenuItem
						onClick={openDevices}
						className="gap-2.5 px-2.5 py-2 text-[13px]"
					>
						<ArrowLeftRight className="size-4" />
						<span className="flex-1">Worktree handoff</span>
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
					{pr?.state === "none" ? "Create PR" : "Open"}
				</span>
			</button>
			{prRows.checks !== null ? (
				<div className={`${rowClass} justify-between`}>
					<PreviewCard onOpenChange={hydrateChecks}>
						<PreviewCardTrigger
							render={
								<button
									type="button"
									className="flex min-h-7 min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
									onClick={() => revealPanel("pr")}
								>
									<ChecksStatusIcon kind={prRows.checks.kind} />
									<span className="min-w-0 flex-1 truncate">
										GitHub Actions
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
							sideOffset={12}
							className="w-80 p-1.5"
						>
							<ChecksPreview
								checks={prDetails?.checkRuns ?? null}
								loading={
									prDetailsLoading ||
									checksRequestedKey !==
										`${ctx.environmentId}:${ctx.folderId}:${ctx.worktreeId ?? "main"}`
								}
							/>
						</PreviewCardPopup>
					</PreviewCard>
					{prRows.checks.canFix && folderId !== null ? (
						<span className="pointer-events-none shrink-0 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 motion-reduce:transition-none">
							<FixActionsButton
								presentation="inline"
								folderId={folderId}
								worktreeId={worktreeId}
								disabled={sessionId === null}
							/>
						</span>
					) : null}
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
						<span className="min-w-0 flex-1 truncate">Merge conflicts</span>
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
						<span className="min-w-0 flex-1 truncate">Plan</span>
					</button>
				</>
			) : null}
			{subagents.length > 0 ? (
				<section className="mx-2 mt-2 border-border/70 border-t px-0.5 pb-1 pt-3">
					<h3 className="mb-2 text-xs font-medium text-muted-foreground">
						Subagents
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
								? `${activeSubagents} active`
								: `${subagents.length} done`}
						</span>
					</button>
				</section>
			) : null}
		</aside>
	);
}

type CheckKind = "failure" | "pending" | "success" | "neutral";

const checkKind = (check: GitPrCheckRun): CheckKind => {
	if (check.status !== "completed") return "pending";
	switch (check.conclusion) {
		case "success":
			return "success";
		case "failure":
		case "cancelled":
		case "timed_out":
		case "action_required":
			return "failure";
		default:
			return "neutral";
	}
};

const checkStatusLabel = (check: GitPrCheckRun): string => {
	const kind = checkKind(check);
	if (kind === "pending") return "Running";
	if (kind === "success") return "Succeeded";
	if (kind === "failure") return "Failed";
	return check.conclusion === "skipped" ? "Skipped" : "Completed";
};

function ChecksStatusIcon({
	kind,
}: {
	kind: "pending" | "failure" | "success";
}) {
	if (kind === "pending") {
		return (
			<HugeiconsIcon
				icon={Loading02Icon}
				className="size-4 shrink-0 animate-spin text-[var(--accent-amber)]"
			/>
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

function ChecksPreview({
	checks,
	loading,
}: {
	checks: ReadonlyArray<GitPrCheckRun> | null;
	loading: boolean;
}) {
	if (loading) {
		return (
			<div className="flex min-h-24 items-center justify-center gap-2 text-xs text-muted-foreground">
				<HugeiconsIcon icon={Loading02Icon} className="size-4 animate-spin" />
				Loading checks…
			</div>
		);
	}
	if (checks === null || checks.length === 0) {
		return (
			<div className="flex min-h-24 items-center justify-center text-xs text-muted-foreground">
				{checks === null
					? "Check details unavailable."
					: "No check details available."}
			</div>
		);
	}

	const rank: Record<CheckKind, number> = {
		failure: 0,
		pending: 1,
		success: 2,
		neutral: 3,
	};
	const ordered = [...checks].sort(
		(left, right) => rank[checkKind(left)] - rank[checkKind(right)],
	);

	return (
		<ul className="flex min-h-24 w-full flex-col">
			{ordered.map((check, index) => {
				const kind = checkKind(check);
				return (
					<li
						key={`${check.name}-${index}`}
						className="flex min-h-9 items-center gap-2 rounded-lg px-2.5 text-[12px] text-foreground"
					>
						<span className="grid size-4 shrink-0 place-items-center">
							{kind === "pending" ? (
								<HugeiconsIcon
									icon={Clock01Icon}
									className="size-3.5 text-[var(--accent-amber)]"
								/>
							) : kind === "neutral" ? (
								<HugeiconsIcon
									icon={CheckListIcon}
									className="size-3.5 text-muted-foreground"
								/>
							) : (
								<ChecksStatusIcon
									kind={kind === "failure" ? "failure" : "success"}
								/>
							)}
						</span>
						<span className="min-w-0 flex-1 truncate">{check.name}</span>
						<span
							className={`shrink-0 text-muted-foreground ${
								kind === "failure"
									? "text-[var(--accent-red)]"
									: kind === "success"
										? "text-[var(--accent-green)]"
										: ""
							}`}
						>
							{checkStatusLabel(check)}
						</span>
					</li>
				);
			})}
		</ul>
	);
}
