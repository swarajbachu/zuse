import { HugeiconsIcon } from "@hugeicons/react";
import {
	Alert01Icon,
	CheckListIcon,
	ComputerTerminal01Icon,
	GitBranchIcon,
	GitCompareIcon,
	GitMergeIcon,
	GitPullRequestIcon,
	Loading02Icon,
	Tick02Icon,
} from "@hugeicons-pro/core-solid-rounded";
import type { Message } from "@zuse/contracts";
import { latestProposedPlanMarkdown } from "@zuse/utils/proposed-plan";
import { useMemo } from "react";

import { displayPath } from "../lib/display-path.ts";
import { detachedSubagentGroups } from "../lib/group-messages.ts";
import { useActiveContext } from "../store/active-workspace.ts";
import { gitStatusKey, useGitStatusStore } from "../store/git-status.ts";
import { useMessagesStore } from "../store/messages.ts";
import { prStateKey, usePrStateStore } from "../store/pr-state.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { EMPTY_WORKTREES, useWorktreesStore } from "../store/worktrees.ts";
import { SubagentAvatar } from "./subagent-identity.tsx";
import { WorkflowActions } from "./top-bar.tsx";

const rowClass =
	"group flex min-h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60";
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

export function EnvironmentSummary() {
	const ctx = useActiveContext();
	const folderId = ctx.status === "ready" ? ctx.folderId : null;
	const worktreeId = ctx.status === "ready" ? ctx.worktreeId : null;
	const status = useGitStatusStore((s) =>
		folderId ? (s.byKey[gitStatusKey(folderId, worktreeId)] ?? null) : null,
	);
	const pr = usePrStateStore((s) =>
		folderId ? (s.byKey[prStateKey(folderId, worktreeId)] ?? null) : null,
	);
	const revealPanel = useUiStore((s) => s.revealPanel);
	const selectSubagent = useUiStore((s) => s.selectSubagent);
	const sessionId = useSessionsStore((s) => s.selectedSessionId);
	const session = useSessionsStore((s) => {
		if (sessionId === null) return null;
		for (const sessions of Object.values(s.sessionsByProject)) {
			const match = sessions.find((candidate) => candidate.id === sessionId);
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

	if (ctx.status !== "ready") return null;

	const checkoutLabel =
		ctx.rootKind === "worktree"
			? `Worktree ${worktree?.name ?? "preparing…"}`
			: "Main checkout";
	const branchLabel = status?.branch ?? worktree?.branch ?? "Loading branch…";
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
	const checksLabel =
		pr?.state === "open" && pr.checksTotal > 0
			? pr.checksRunning > 0
				? `${pr.checksRunning} checks running`
				: pr.checksFailing > 0
					? `${pr.checksFailing} checks failing`
					: "Checks passed"
			: null;
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
		if (
			pr.state === "open" &&
			(pr.checksFailing > 0 || pr.mergeable === "conflicting")
		) {
			return {
				icon: Alert01Icon,
				label: "Pull request needs attention",
				className: "text-[var(--accent-red)]",
			};
		}
		if (pr.state === "open" && pr.checksRunning > 0) {
			return {
				icon: Loading02Icon,
				label: "Pull request checks running",
				className: "animate-spin text-[var(--accent-amber)]",
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
		if (pr?.state === "none" && sessionId !== null) {
			void useMessagesStore
				.getState()
				.send(sessionId, "create a pull request for this branch");
			return;
		}
		revealPanel("pr");
	};

	return (
		<aside
			aria-label="Environment summary"
			className="ml-3 mt-3 w-72 shrink-0 self-start rounded-3xl border border-border/70 bg-card/80 p-1.5 shadow-sm"
		>
			<h2 className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
				Environment
			</h2>
			<button
				type="button"
				className={`${rowClass} hover:bg-muted/60`}
				onClick={() => revealPanel("changes")}
			>
				<HugeiconsIcon icon={GitCompareIcon} className="size-4 shrink-0" />
				<span className="min-w-0 flex-1 truncate">{changesLabel}</span>
			</button>
			<div className={rowClass} title={displayPath(ctx.rootPath)}>
				<HugeiconsIcon
					icon={ComputerTerminal01Icon}
					className="size-4 shrink-0 text-muted-foreground"
				/>
				<span className="min-w-0 flex-1 truncate">{checkoutLabel}</span>
			</div>
			<div className={rowClass}>
				<HugeiconsIcon
					icon={GitBranchIcon}
					className="size-4 shrink-0 text-muted-foreground"
				/>
				<span className="min-w-0 flex-1 truncate" title={branchLabel}>
					{branchLabel}
				</span>
				{status !== null && (status.ahead > 0 || status.behind > 0) ? (
					<span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
						{status.ahead > 0 ? `↑${status.ahead}` : ""}
						{status.behind > 0 ? ` ↓${status.behind}` : ""}
					</span>
				) : null}
			</div>
			{/* One row: PR status on the left, the same workflow buttons as the
			    dock top bar (Create PR / Commit & push / Archive / …) inline on
			    the right — status and action for the same thing share a line. */}
			<div className={`${rowClass} justify-between`}>
				<button
					type="button"
					className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
					onClick={openPullRequest}
				>
					<HugeiconsIcon
						icon={prStatus.icon}
						className={`size-4 shrink-0 ${prStatus.className}`}
						aria-label={prStatus.label}
					/>
					<span className="min-w-0 flex-1 truncate">
						<span className="block truncate">{prLabel}</span>
						{checksLabel !== null ? (
							<span className="block truncate text-[11px] text-muted-foreground">
								{checksLabel}
							</span>
						) : null}
					</span>
				</button>
				<WorkflowActions compact includeRun={false} />
			</div>
			{planAvailable ? (
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
							selectSubagent(null);
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
