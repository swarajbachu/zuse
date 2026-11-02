import { formatNumber as formatUiNumber } from "@zuse/i18n";
import { useGitPrState } from "../lib/use-git-pr-state.ts";
import { BackgroundTasks } from "./background-tasks.tsx";
import { GitStackMenu } from "./git-stack-menu.tsx";
import { GitHubStatusNotice } from "./github-status-notice.tsx";
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
	CheckListIcon,
	ComputerPhoneSyncIcon,
	GitCompareIcon,
	GitMergeIcon,
	GitPullRequestIcon,
	LaptopIcon,
	Layers01Icon,
	Loading02Icon,
	ServerStack01Icon,
	Tick02Icon,
} from "@zuse/icons/solid-rounded";
import { latestProposedPlanMarkdown } from "@zuse/utils/proposed-plan";

import { useEffect, useMemo, useRef, useState } from "react";

import { deriveEnvironmentPrRows } from "../lib/branch-workflow.ts";
import { chatPullRequests } from "../lib/chat-pull-requests.ts";
import { useCloudChatCatalogStore } from "../lib/cloud-workspace-catalog.ts";
import { displayPath } from "../lib/display-path.ts";
import { useEnvironmentEntities } from "../lib/environment-entity-hooks.ts";
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
import { useGitStack } from "../store/git-stack.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { EMPTY_WORKTREES, useWorktreesStore } from "../store/worktrees.ts";
import { AgentsSummary } from "./agents-summary.tsx";
import { ChatPullRequestList } from "./chat-pull-request-list.tsx";
import {
	CloudWorkspaceInfo,
	summaryRowClass as rowClass,
	summaryMetaClass,
} from "./cloud-workspace-info.tsx";
import { SummaryActivity, SummarySection } from "./summary-section.tsx";
import { BranchMenuButton } from "./top-bar.tsx";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu.tsx";
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
	const locationEnvironmentId =
		ctx.status === "ready" ? ctx.environmentId : activeEnvironmentId;
	const locationEntry = useEnvironmentCatalogStore(
		(state) =>
			state.entries.find(
				(entry) => entry.environmentId === locationEnvironmentId,
			) ?? null,
	);
	const environmentLocation = deriveEnvironmentLocation({
		activeEnvironmentId: locationEnvironmentId,
		localEnvironmentId: getLocalEnvironmentId(),
		activeEntry: locationEntry,
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
	const stack = useGitStack(executionRef, status?.branch ?? null);
	const diffStat = gitView.data?.diffStat ?? null;
	const [branches, setBranches] = useState<ReadonlyArray<GitBranchInfo>>([]);
	const [branchesLoading, setBranchesLoading] = useState(false);
	const [branchError, setBranchError] = useState<string | null>(null);

	const prDetailsLoading = prDetailsView.sync === "synchronizing";
	const revealPanelForChat = useUiStore((s) => s.revealPanelForChat);
	const sessionId = useSessionsStore((s) => s.selectedSessionId);
	const { sessionsByProject } = useEnvironmentEntities(
		environmentId ?? activeEnvironmentId,
	);
	const session =
		Object.values(sessionsByProject)
			.flat()
			.find((candidate) => candidate.id === sessionId) ?? null;
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
		() => detachedSubagentGroups(messages, timeline.projection?.executionSteps),
		[messages, timeline.projection?.executionSteps, uiMessage],
	);
	const worktree = useWorktreesStore((s) => {
		if (ctx.status !== "ready" || ctx.worktreeId === null) return null;
		return (
			(s.byProject[ctx.folderId] ?? EMPTY_WORKTREES).find(
				(item) => item.id === ctx.worktreeId,
			) ?? null
		);
	});
	const gitFailed = gitView.sync === "failed";
	const branchLabel =
		status?.branch ??
		worktree?.branch ??
		(gitFailed ? "Branch unavailable" : "Loading branch…");
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

	const prLabel =
		pr === null
			? gitFailed
				? "Pull request unavailable"
				: "Loading pull request…"
			: pr.state === "none"
				? "Pull request"
				: `PR #${pr.number ?? "?"} · ${pr.state}`;
	const prRows = deriveEnvironmentPrRows(pr);
	const linkedPullRequests = chatPullRequests({
		pr,
		title: prDetails?.title ?? null,
		stack,
	});
	const prStatus = (() => {
		if (pr === null) {
			return {
				icon: gitFailed ? Alert01Icon : Loading02Icon,
				label: prLabel,
				className: gitFailed
					? "text-muted-foreground"
					: "animate-spin text-muted-foreground",
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
			className="pointer-events-auto max-h-[calc(100dvh-7rem)] w-72 shrink-0 overflow-y-auto rounded-xl bg-glass border-glass p-1.5"
		>
			{cloudWorkspaceId !== null ? (
				<CloudWorkspaceInfo workspaceId={cloudWorkspaceId} />
			) : (
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
						{environmentLocation.isLocal ? null : (
							<span className={summaryMetaClass}>
								<span
									className={`size-1.5 rounded-full ${environmentLocation.connected ? "bg-[var(--accent-green)]" : "bg-[var(--accent-amber)]"}`}
								/>
							</span>
						)}
					</MenuTrigger>
					<MenuPopup side="left" align="start" sideOffset={8} className="w-64">
						<div className="px-2 pb-0.5 pt-1 text-xs font-medium text-muted-foreground">
							{uiMessage("chat:environment_summary_running_on")}
						</div>
						<div className="flex flex-col gap-0.5 px-2 pb-1 text-xs">
							<span className="flex items-center gap-2">
								<HugeiconsIcon icon={EnvironmentIcon} className="size-4" />
								<span className="min-w-0 flex-1 truncate">
									{environmentLocation.menuLabel}
								</span>
							</span>
							<span
								className="truncate pl-6 font-mono text-[11px] text-muted-foreground"
								title={ctx.rootPath}
							>
								{displayPath(ctx.rootPath)}
							</span>
						</div>
						<MenuItem
							onClick={openDevices}
							className="h-7 gap-2 px-2 py-0 text-xs"
						>
							<HugeiconsIcon icon={ComputerPhoneSyncIcon} className="size-4" />
							<span className="flex-1">
								{uiMessage("chat:environment_summary_connected_devices")}
							</span>
						</MenuItem>
					</MenuPopup>
				</Menu>
			)}
			<BranchMenuButton
				branchLabel={branchLabel}
				branches={branches}
				canRename={false}
				className={`${rowClass} max-w-none justify-start hover:bg-muted/60 data-[popup-open]:bg-muted/60`}
				popupSide="left"
				dirtyFiles={status?.dirtyFiles ?? 0}
				variant="summary"
				error={branchError}
				loading={branchesLoading}
				onOpen={() => void refreshBranches()}
				onRename={() => {}}
				onSwitch={(branch) => void switchToBranch(branch)}
			/>
			<button
				type="button"
				className={`${rowClass} hover:bg-muted/60`}
				onClick={() => revealPanel("changes")}
			>
				<HugeiconsIcon
					icon={GitCompareIcon}
					className="size-4 shrink-0 text-muted-foreground"
				/>
				<span className="min-w-0 flex-1 truncate">
					{uiMessage("chat:environment_summary_branch_changes")}
				</span>
				{diffStat !== null && diffStat.additions + diffStat.deletions > 0 ? (
					<span className={`${summaryMetaClass} gap-1 font-mono`}>
						<span className="text-[var(--accent-green)]">
							+{compactNumber(diffStat.additions)}
						</span>
						<span className="text-danger-text">
							−{compactNumber(diffStat.deletions)}
						</span>
					</span>
				) : null}
			</button>
			{pr && pr.state !== "none" && executionRef ? (
				<PrActionsMenu
					executionRef={executionRef}
					pr={pr}
					details={prDetails}
					sessionId={sessionId}
					action={prRows.action}
					className={`${rowClass} hover:bg-muted/60 has-[[data-popup-open]]:bg-muted/60`}
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
					<span className={summaryMetaClass}>
						{pr?.state === "none"
							? uiMessage("chat:environment_summary_create_pr")
							: uiMessage("common:open")}
					</span>
				</button>
			)}
			{executionRef !== null &&
			stack?.branches.some(
				(item) => item.isCurrent && item.name === status?.branch,
			) ? (
				<SummarySection
					icon={Layers01Icon}
					label={uiMessage("chat:environment_summary_stack")}
					meta={uiMessage("chat:environment_summary_stack_count", {
						count: linkedPullRequests.length,
					})}
				>
					{linkedPullRequests.length > 1 ? (
						<ChatPullRequestList pullRequests={linkedPullRequests} limit={5} />
					) : null}
					<GitStackMenu
						branch={status?.branch ?? null}
						key={`${executionRef.environmentId}:${executionRef.folderId}:${executionRef.worktreeId}:${status?.branch}`}
						executionRef={executionRef}
						className="flex h-6 w-full items-center rounded-md ps-[34px] text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-[popup-open]:text-foreground"
						trigger={uiMessage("chat:environment_summary_manage_stack")}
					/>
				</SummarySection>
			) : null}
			<GitHubStatusNotice pr={pr} executionRef={executionRef} />
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
									<span className={summaryMetaClass}>
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
			{planAvailable ? (
				<button
					type="button"
					className={`${rowClass} hover:bg-muted/60`}
					onClick={() => revealPanel("plan")}
				>
					<HugeiconsIcon
						icon={CheckListIcon}
						className="size-4 shrink-0 text-muted-foreground"
					/>
					<span className="min-w-0 flex-1 truncate">
						{uiMessage("chat:environment_summary_plan")}
					</span>
				</button>
			) : null}
			<SummaryActivity>
				{timeline.ref !== null && session !== null ? (
					<BackgroundTasks
						key={`${timeline.ref.environmentId}:${timeline.ref.sessionId}`}
						view={timeline.view}
						sessionRef={timeline.ref}
						providerId={session.providerId}
					/>
				) : null}
				{chatRef !== null && session !== null ? (
					<AgentsSummary
						key={`${chatRef.environmentId}:${session.id}`}
						chatRef={chatRef}
						session={session}
						sessions={Object.values(sessionsByProject).flat()}
						nativeAgents={subagents}
					/>
				) : null}
			</SummaryActivity>
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
