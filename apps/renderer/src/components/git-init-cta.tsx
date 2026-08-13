import { HugeiconsIcon } from "@hugeicons/react";
import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import { GitBranchIcon, Loading02Icon } from "@zuse/icons/solid-rounded";
import { useState } from "react";

import { formatError } from "../lib/format-error.ts";
import { initializeGitRepository } from "../lib/git-workspace-client-bus.ts";

/**
 * Shared empty state shown wherever a git operation fails because the folder
 * isn't a Git repository (`GitNotARepoError`) — the Changes tab, the PR tab,
 * and the file Diff view all render this instead of dumping a raw error.
 * Clicking the button runs `git init` and refreshes the canonical Git workspace
 * resource so every retained surface recovers from the same snapshot.
 *
 * `compact` drops the explanatory line for tight spots like the Diff pane.
 */
export function GitInitCta({
	executionRef,
	compact = false,
	onInitialized,
}: {
	executionRef: ExecutionRef;
	compact?: boolean;
	/**
	 * Fired after `git init` succeeds. Surfaces for callers (e.g. the Diff
	 * view) that fetch their own data in a local effect and need to re-run it.
	 */
	onInitialized?: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const onInit = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await initializeGitRepository(executionRef);
			onInitialized?.();
		} catch (err) {
			setError(formatError(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col items-start gap-2 py-1">
			<div className="flex flex-col gap-0.5">
				<span className="font-medium text-foreground">
					This folder isn't a Git repository
				</span>
				{!compact ? (
					<span className="text-muted-foreground">
						Initialize Git to track changes, commit, and open pull requests.
					</span>
				) : null}
			</div>
			<button
				type="button"
				onClick={onInit}
				disabled={busy}
				className="flex items-center gap-1.5 rounded-sm bg-emerald-500/15 px-2 py-1 text-[11px] font-medium text-emerald-200 transition-colors hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-40"
			>
				{busy ? (
					<HugeiconsIcon icon={Loading02Icon} className="size-3 animate-spin" />
				) : (
					<HugeiconsIcon icon={GitBranchIcon} className="size-3" />
				)}
				Initialize Git repository
			</button>
			{error !== null ? (
				<span className="text-rose-300/90">{error}</span>
			) : null}
		</div>
	);
}
