import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import {
	CommandId,
	type GitPrDetails,
	type GitPrInfo,
	type SessionId,
} from "@zuse/contracts";
import {
	ArrowUpRight,
	ChevronDown,
	FileText,
	GitMerge,
	GitPullRequest,
	MessageSquarePlus,
	Wrench,
} from "lucide-react";
import { useState } from "react";
import {
	attachFileWhenReady,
	saveContextFile,
} from "../lib/context-handoff.ts";
import { formatError } from "../lib/format-error.ts";
import {
	dispatchGitWorkspaceCommand,
	gitWorkspaceResourceKey,
	refreshGitWorkspace,
} from "../lib/git-workspace-client-bus.ts";
import { openExternal } from "../lib/platform-capabilities.ts";
import {
	type PrRepairScope,
	preparePrRepair,
	prRepairMarkdown,
} from "../lib/pr-repair.ts";
import { sendSessionMessage } from "../lib/session-actions.ts";
import {
	getRendererClientBus,
	sessionTimelineResourceKey,
} from "../lib/session-timeline-client-bus.ts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { useMergePrefs } from "../store/merge-prefs.ts";
import { useSessionsStore } from "../store/sessions.ts";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuSub,
	MenuSubPopup,
	MenuSubTrigger,
	MenuTrigger,
} from "./ui/menu.tsx";
import { toastManager } from "./ui/toast.tsx";

export function PrActionsMenu({
	executionRef,
	pr,
	details,
	sessionId,
	busy: agentBusy,
	className,
	onView,
	onChanges,
	onChat,
}: {
	executionRef: ExecutionRef;
	pr: GitPrInfo;
	details: GitPrDetails | null;
	sessionId: SessionId | null;
	busy: boolean;
	className?: string;
	onView: () => void;
	onChanges: () => void;
	onChat: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const method = useMergePrefs((state) => state.method);
	const deleteBranch = useMergePrefs((state) => state.deleteBranch);
	const run = async (action: () => Promise<unknown>) => {
		if (busy) return;
		setBusy(true);
		try {
			await action();
		} catch (error) {
			toastManager.add({
				type: "error",
				title: "GitHub action failed",
				description: formatError(error),
			});
		} finally {
			setBusy(false);
		}
	};
	const setStatus = (state: "ready" | "draft" | "closed" | "open") =>
		run(() =>
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
	const merge = (action: "merge" | "enable-auto" | "disable-auto") =>
		run(() =>
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
	const isSelectedChat = () =>
		useSessionsStore.getState().selectedSessionId === sessionId &&
		useEnvironmentCatalogStore.getState().activeEnvironmentId ===
			executionRef.environmentId;
	const repair = (scope: PrRepairScope) =>
		run(async () => {
			if (!details || !sessionId) return;
			const input = await preparePrRepair(
				executionRef,
				sessionId,
				details,
				scope,
			);
			await refreshGitWorkspace(executionRef);
			const bus = getRendererClientBus();
			const workspace = bus.snapshot(gitWorkspaceResourceKey(executionRef));
			const timeline = bus.snapshot(
				sessionTimelineResourceKey({
					environmentId: executionRef.environmentId,
					sessionId,
				}),
			);
			if (
				!isSelectedChat() ||
				workspace.sync !== "live" ||
				workspace.connection !== "connected" ||
				workspace.data?.error != null ||
				workspace.data?.status?.branch !== details.headBranch ||
				workspace.data?.pr?.url !== details.url ||
				timeline.sync !== "live" ||
				timeline.connection !== "connected" ||
				timeline.data?.status !== "idle" ||
				timeline.data.currentTurn !== null ||
				timeline.data.queue.items.length > 0 ||
				timeline.pendingCommands.length > 0
			)
				throw new Error(
					"The chat, branch, or agent state changed. Run Repair again from the current PR.",
				);

			onChat();
			await sendSessionMessage(
				{ environmentId: executionRef.environmentId, sessionId },
				input,
			);
		});
	const comments = details
		? [...details.comments, ...details.reviews].filter((item) =>
				item.body.trim(),
			).length
		: 0;
	return (
		<Menu>
			<MenuTrigger className={className} disabled={busy}>
				<GitPullRequest className="size-4 shrink-0" />
				<span className="min-w-0 flex-1 truncate">
					{details?.title || `PR #${pr.number}`}
				</span>
				<ChevronDown className="size-3 shrink-0 text-muted-foreground" />
			</MenuTrigger>
			<MenuPopup side="left" align="start" className="w-64">
				<MenuItem onClick={onView}>
					<FileText className="size-4" />
					View PR
				</MenuItem>
				<MenuItem onClick={onChanges}>
					Code changes{" "}
					<span className="ml-auto text-xs">
						<span className="text-[var(--accent-green)]">+{pr.additions}</span>{" "}
						<span className="text-[var(--accent-red)]">−{pr.deletions}</span>
					</span>
				</MenuItem>
				<MenuSub>
					<MenuSubTrigger
						disabled={!details || !sessionId || agentBusy || busy}
					>
						<Wrench className="size-4" />
						Repair
					</MenuSubTrigger>
					<MenuSubPopup>
						<MenuItem
							disabled={comments === 0}
							onClick={() => void repair("comments")}
						>
							Comments <span className="ml-auto">{comments}</span>
						</MenuItem>
						<MenuItem
							disabled={pr.checks !== "failure"}
							onClick={() => void repair("checks")}
						>
							Failing checks <span className="ml-auto">{pr.checksFailing}</span>
						</MenuItem>
						<MenuItem
							disabled={pr.mergeable !== "conflicting"}
							onClick={() => void repair("conflicts")}
						>
							Merge conflicts
						</MenuItem>
						<MenuSeparator />
						<MenuItem
							disabled={
								comments === 0 &&
								pr.checks !== "failure" &&
								pr.mergeable !== "conflicting"
							}
							onClick={() => void repair("everything")}
						>
							Everything
						</MenuItem>
					</MenuSubPopup>
				</MenuSub>
				{pr.state === "open" && !pr.isDraft ? (
					<MenuSub>
						<MenuSubTrigger disabled={busy}>
							<GitMerge className="size-4" />
							Merge
						</MenuSubTrigger>
						<MenuSubPopup>
							<MenuItem
								disabled={
									pr.mergeable !== "clean" ||
									pr.checks === "failure" ||
									pr.checks === "pending"
								}
								onClick={() => void merge("merge")}
							>
								Merge
							</MenuItem>
							<MenuItem
								onClick={() =>
									void merge(
										pr.autoMergeEnabled ? "disable-auto" : "enable-auto",
									)
								}
							>
								{pr.autoMergeEnabled
									? "Disable auto-merge"
									: "Enable auto-merge"}
							</MenuItem>
						</MenuSubPopup>
					</MenuSub>
				) : null}
				<MenuItem
					disabled={!details || !sessionId || busy}
					onClick={() =>
						void run(async () => {
							if (!details || !sessionId) return;
							const file = await saveContextFile(
								executionRef.environmentId,
								sessionId,
								prRepairMarkdown(details, "everything"),
							);
							if (!file) throw new Error("Could not attach PR context.");
							if (!isSelectedChat()) return;
							onChat();
							attachFileWhenReady(file, 20, 50, {
								environmentId: executionRef.environmentId,
								sessionId,
							});
						})
					}
				>
					<MessageSquarePlus className="size-4" />
					Add to chat
				</MenuItem>
				<MenuSeparator />
				{pr.state !== "merged" ? (
					<MenuSub>
						<MenuSubTrigger disabled={busy}>
							Status{" "}
							<span className="ml-auto text-muted-foreground">
								{pr.state === "closed"
									? "Closed"
									: pr.isDraft
										? "Draft"
										: "Ready for review"}
							</span>
						</MenuSubTrigger>
						<MenuSubPopup>
							<MenuItem
								disabled={pr.state !== "open" || pr.isDraft}
								onClick={() => void setStatus("draft")}
							>
								Draft
							</MenuItem>
							<MenuItem
								disabled={pr.state !== "open" || !pr.isDraft}
								onClick={() => void setStatus("ready")}
							>
								Ready for review
							</MenuItem>
							<MenuItem
								onClick={() =>
									void setStatus(pr.state === "closed" ? "open" : "closed")
								}
							>
								{pr.state === "closed" ? "Reopen" : "Close"}
							</MenuItem>
						</MenuSubPopup>
					</MenuSub>
				) : null}
				<MenuItem
					disabled={!pr.url}
					onClick={() => {
						if (pr.url) void openExternal(pr.url);
					}}
				>
					<ArrowUpRight className="size-4" />
					Open in GitHub
				</MenuItem>
			</MenuPopup>
		</Menu>
	);
}
