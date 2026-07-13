import { HugeiconsIcon } from "@hugeicons/react";
import {
	ComputerTerminal01Icon,
	GitBranchIcon,
	GitCompareIcon,
	LinkSquare01Icon,
} from "@hugeicons-pro/core-bulk-rounded";
import { GitPullRequestIcon } from "@hugeicons-pro/core-solid-rounded";

import { useActiveContext } from "../store/active-workspace.ts";
import { gitStatusKey, useGitStatusStore } from "../store/git-status.ts";
import { prStateKey, usePrStateStore } from "../store/pr-state.ts";
import { useUiStore } from "../store/ui.ts";
import { EMPTY_WORKTREES, useWorktreesStore } from "../store/worktrees.ts";
import { TopBarRightContent } from "./top-bar.tsx";

const rowClass =
	"flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg px-3 text-left text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

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
			? (worktree?.name ?? "Preparing worktree…")
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
				? "No pull request"
				: `PR #${pr.number ?? "?"} · ${pr.state}`;
	const checksLabel =
		pr?.state === "open" && pr.checksTotal > 0
			? pr.checksRunning > 0
				? `${pr.checksRunning} checks running`
				: pr.checksFailing > 0
					? `${pr.checksFailing} checks failing`
					: "Checks passed"
			: null;

	return (
		<aside
			aria-label="Environment summary"
			className="ml-4 mt-4 w-72 shrink-0 self-start rounded-2xl border border-border/70 bg-card/80 p-2 shadow-sm"
		>
			<h2 className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">
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
			<div className={rowClass} title={ctx.rootPath}>
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
			<button
				type="button"
				className={`${rowClass} hover:bg-muted/60`}
				onClick={() => revealPanel("pr")}
			>
				<HugeiconsIcon icon={GitPullRequestIcon} className="size-4 shrink-0" />
				<span className="min-w-0 flex-1 truncate">
					<span className="block truncate">{prLabel}</span>
					{checksLabel !== null ? (
						<span className="block truncate text-[11px] text-muted-foreground">
							{checksLabel}
						</span>
					) : null}
				</span>
				{pr?.url ? (
					<HugeiconsIcon
						icon={LinkSquare01Icon}
						className="size-3.5 shrink-0 text-muted-foreground"
					/>
				) : null}
			</button>
			<div className="border-t border-border/60 px-3 py-3">
				<div className="mb-2 text-[11px] font-medium text-muted-foreground">
					Status
				</div>
				<TopBarRightContent compact />
			</div>
		</aside>
	);
}
