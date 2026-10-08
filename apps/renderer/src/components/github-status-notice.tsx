import "@zuse/i18n/english/projects";
import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import type { GitPrInfo } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { useState } from "react";
import { gitHubStatusMessageKey } from "../lib/git-pr-state.ts";
import { refreshGitPrDetails } from "../lib/git-workspace-client-bus.ts";

/** Shared compact freshness label across the header, summary, and PR pane. */
export function GitHubStatusNotice({
	pr,
	executionRef,
}: {
	pr: GitPrInfo | null;
	executionRef: ExecutionRef | null;
}) {
	const [busy, setBusy] = useState(false);
	const { message } = useMessages("projects");
	const key = gitHubStatusMessageKey(pr);
	const label = key ? message(key) : null;
	if (!label) return null;
	const waiting = (pr?.retryAt?.getTime() ?? 0) > Date.now();
	return (
		<button
			type="button"
			aria-live="polite"
			title={label}
			className="h-7 min-w-0 truncate rounded-md px-1.5 text-left text-[11px] text-muted-foreground hover:bg-muted/40 disabled:cursor-default"
			disabled={!executionRef || busy || waiting}
			onClick={() => {
				if (!executionRef) return;
				setBusy(true);
				void refreshGitPrDetails(executionRef)
					.catch(() => undefined)
					.finally(() => setBusy(false));
			}}
		>
			{busy ? message("projects:github_observation_refreshing") : label}
		</button>
	);
}
