import { HugeiconsIcon } from "@hugeicons/react";
import { GitBranchIcon } from "@hugeicons-pro/core-stroke-rounded";

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

export function BranchIcon({
	state = "default",
	selected = false,
	className,
}: {
	state?: BranchState;
	selected?: boolean;
	className?: string;
}) {
	const color = COLOR_BY_STATE[state];
	return (
		<HugeiconsIcon
			icon={GitBranchIcon}
			className={cn(
				"size-3.5 shrink-0 transition-colors",
				selected ? color.selected : color.idle,
				className,
			)}
			aria-hidden="true"
		/>
	);
}
