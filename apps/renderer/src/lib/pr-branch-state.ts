import type { GitPrInfo } from "@zuse/contracts";

import type { BranchState } from "../components/branch-icon.tsx";
import type { GitDiffStat } from "./git-workspace-client-bus.ts";

/**
 * Shared derivations for a sidebar chat row's branch icon and `+N −N` slot,
 * used by both active-environment rows and rows from other computers so the
 * two never drift apart.
 */
export const branchStateFor = (
	prInfo: GitPrInfo | null,
	isArchived: boolean,
): BranchState =>
	isArchived
		? "archived"
		: prInfo === null || prInfo.state === "none"
			? "default"
			: prInfo.state === "merged"
				? "pr-merged"
				: prInfo.state === "closed"
					? "pr-closed"
					: // open PR — reflect CI / conflict status
						prInfo.checks === "failure" || prInfo.mergeable === "conflicting"
						? "pr-failing"
						: prInfo.checks === "pending"
							? "pr-pending"
							: "pr-open";

/**
 * Prefer the live branch diff (works without a PR); fall back to the PR's
 * own counts so merged/closed branches still show their size. Null when
 * there is nothing to show.
 */
export const diffStatsFor = (
	diffStat: GitDiffStat | null,
	prInfo: GitPrInfo | null,
): GitDiffStat | null =>
	diffStat !== null && (diffStat.additions > 0 || diffStat.deletions > 0)
		? diffStat
		: prInfo !== null && (prInfo.additions > 0 || prInfo.deletions > 0)
			? { additions: prInfo.additions, deletions: prInfo.deletions }
			: null;
