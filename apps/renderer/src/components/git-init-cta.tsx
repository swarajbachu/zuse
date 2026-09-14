import "@zuse/i18n/english/projects";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
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
	const { message: uiMessage } = useUiMessages(["projects"]);

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
					{uiMessage(
						"projects:git_init_cta_this_folder_isn_t_a_git_repository",
					)}
				</span>
				{!compact ? (
					<span className="text-muted-foreground">
						{uiMessage(
							"projects:git_init_cta_initialize_git_to_track_changes_commit_and_open_pull_requests",
						)}
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
				{uiMessage("projects:git_init_cta_initialize_git_repository")}
			</button>
			{error !== null ? (
				<span className="text-rose-300/90">{error}</span>
			) : null}
		</div>
	);
}
