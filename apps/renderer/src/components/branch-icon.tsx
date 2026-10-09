import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { GitPrInfo } from "@zuse/contracts";
import {
	GitBranchIcon,
	GitMergeConflictIcon,
	GitMergeIcon,
	GitPullRequestClosedIcon,
	GitPullRequestDraftIcon,
	GitPullRequestIcon,
} from "@zuse/icons/solid-rounded";

import { cn } from "~/lib/utils";

/**
 * Branch / PR state for a session row's leading glyph. Only color changes
 * with state — the icon shape stays the same so the row never reflows.
 *   - default    — no PR linked yet (muted)
 *   - pr-open    — PR open, checks passing / none (green)
 *   - pr-pending — PR open, checks still running (amber)
 *   - pr-failing — PR open with a failing check or a merge conflict (red)
 *   - pr-merged  — PR merged (purple)
 *   - pr-closed  — PR closed without merging (muted)
 *   - archived   — chat archived (dimmed)
 */
export type BranchState =
	| "default"
	| "pr-open"
	| "pr-pending"
	| "pr-failing"
	| "pr-merged"
	| "pr-closed"
	| "archived";

const COLOR_BY_STATE: Record<BranchState, { idle: string; selected: string }> =
	{
		default: {
			idle: "text-muted-foreground",
			selected: "text-sidebar-accent-foreground",
		},
		"pr-open": { idle: "text-success", selected: "text-success" },
		"pr-pending": { idle: "text-warning", selected: "text-warning" },
		"pr-failing": { idle: "text-destructive", selected: "text-destructive" },
		"pr-merged": { idle: "text-purple-400", selected: "text-purple-300" },
		"pr-closed": {
			idle: "text-muted-foreground",
			selected: "text-sidebar-accent-foreground",
		},
		archived: {
			idle: "text-muted-foreground/60",
			selected: "text-muted-foreground/60",
		},
	};

const branchStateTextClass = (state: BranchState, selected = false): string => {
	const color = COLOR_BY_STATE[state];
	return selected ? color.selected : color.idle;
};

export function BranchIcon({
	state = "default",
	selected = false,
	className,
}: {
	state?: BranchState;
	selected?: boolean;
	className?: string;
}) {
	return (
		<HugeiconsIcon
			icon={GitBranchIcon}
			className={cn(
				"size-3.5 shrink-0 transition-colors",
				branchStateTextClass(state, selected),
				className,
			)}
			aria-hidden="true"
		/>
	);
}

/**
 * GitHub-style pull request glyph: the icon follows the PR lifecycle (open,
 * draft, merged, closed, conflict) and its color follows GitHub's palette,
 * with open PRs tinted by their checks.
 */
export function PrStateIcon({
	pr,
	className,
}: {
	pr: Pick<GitPrInfo, "state" | "isDraft" | "checks" | "mergeable">;
	className?: string;
}) {
	const { icon, tone } = prStateGlyph(pr);
	return (
		<HugeiconsIcon
			icon={icon}
			className={cn("size-3.5 shrink-0", tone, className)}
			aria-hidden="true"
		/>
	);
}

const prStateGlyph = (
	pr: Pick<GitPrInfo, "state" | "isDraft" | "checks" | "mergeable">,
): { icon: IconSvgElement; tone: string } => {
	if (pr.state === "merged")
		return { icon: GitMergeIcon, tone: "text-purple-400" };
	if (pr.state === "closed")
		return { icon: GitPullRequestClosedIcon, tone: "text-destructive" };
	if (pr.mergeable === "conflicting")
		return { icon: GitMergeConflictIcon, tone: "text-destructive" };
	if (pr.isDraft)
		return { icon: GitPullRequestDraftIcon, tone: "text-muted-foreground" };
	if (pr.checks === "failure")
		return { icon: GitPullRequestIcon, tone: "text-destructive" };
	if (pr.checks === "pending")
		return { icon: GitPullRequestIcon, tone: "text-warning" };
	return { icon: GitPullRequestIcon, tone: "text-success" };
};
