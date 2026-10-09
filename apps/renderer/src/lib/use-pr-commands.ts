import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import { CommandId, type GitPrInfo } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { useState } from "react";
import { toastManager } from "../components/ui/toast.tsx";
import { useMergePrefs } from "../store/merge-prefs.ts";
import { formatError } from "./format-error.ts";
import { dispatchGitWorkspaceCommand } from "./git-workspace-client-bus.ts";

export type PrStatusTarget = "ready" | "draft" | "closed" | "open";
export type PrMergeAction = "merge" | "enable-auto" | "disable-auto";
export type PrMergeBlocker =
	| "conflicts"
	| "checks-failing"
	| "checks-running"
	| "not-mergeable";

/** Why an immediate merge is unavailable, or null when GitHub allows it. */
export const prMergeBlocker = (
	pr: Pick<GitPrInfo, "mergeable" | "checks">,
): PrMergeBlocker | null => {
	if (pr.mergeable === "conflicting") return "conflicts";
	if (pr.checks === "failure") return "checks-failing";
	if (pr.checks === "pending") return "checks-running";
	if (pr.mergeable !== "clean") return "not-mergeable";
	return null;
};

/**
 * PR status and merge commands shared by the PR header and actions menu.
 * `pending` names the in-flight command so callers can show progress on the
 * control that started it while every other PR action stays disabled.
 */
export function usePrCommands(executionRef: ExecutionRef) {
	const { message: uiMessage } = useUiMessages(["projects"]);
	const [pending, setPending] = useState<null | PrStatusTarget | PrMergeAction>(
		null,
	);
	const method = useMergePrefs((state) => state.method);
	const deleteBranch = useMergePrefs((state) => state.deleteBranch);
	const run = async (
		name: PrStatusTarget | PrMergeAction,
		action: () => Promise<unknown>,
	) => {
		if (pending !== null) return;
		setPending(name);
		try {
			await action();
		} catch (error) {
			toastManager.add({
				type: "error",
				title: uiMessage("projects:github_action_failed"),
				description: formatError(error),
			});
		} finally {
			setPending(null);
		}
	};
	const setStatus = (state: PrStatusTarget) =>
		run(state, () =>
			dispatchGitWorkspaceCommand({
				ref: executionRef,
				kind: "git.markReady",
				commandId: CommandId.make(`pr-status:${crypto.randomUUID()}`),
				payload: {
					folderId: executionRef.folderId,
					worktreeId: executionRef.worktreeId,
					state,
				},
			}),
		);
	const merge = (action: PrMergeAction) =>
		run(action, () =>
			dispatchGitWorkspaceCommand({
				ref: executionRef,
				kind: "git.mergePr",
				commandId: CommandId.make(`pr-merge:${crypto.randomUUID()}`),
				payload: {
					folderId: executionRef.folderId,
					worktreeId: executionRef.worktreeId,
					action,
					method,
					deleteBranch,
				},
			}),
		);
	return { pending, busy: pending !== null, setStatus, merge };
}
