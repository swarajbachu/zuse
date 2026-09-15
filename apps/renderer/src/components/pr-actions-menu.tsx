import "@zuse/i18n/english/chat";
import "@zuse/i18n/english/projects";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import {
	CommandId,
	type GitPrDetails,
	type GitPrInfo,
	type SessionId,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	ArrowDown01Icon,
	Cancel01Icon,
	CheckmarkCircle02Icon,
	Comment01Icon,
	CommentAdd01Icon,
	File01Icon,
	GithubIcon,
	GitMergeConflictIcon,
	GitMergeIcon,
	GitPullRequestDraftIcon,
	GitPullRequestIcon,
	Robot01Icon,
	Wrench01Icon,
} from "@zuse/icons/stroke-rounded";
import { useState } from "react";
import { formatError } from "../lib/format-error.ts";
import { dispatchGitWorkspaceCommand } from "../lib/git-workspace-client-bus.ts";
import { openExternal } from "../lib/platform-capabilities.ts";
import {
	type PrRepairScope,
	prRepairDraft,
	prRepairMarkdown,
} from "../lib/pr-repair.ts";
import {
	composerDraftKeyForSession,
	useComposerDraftsStore,
} from "../store/composer-drafts.ts";

import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { useMergePrefs } from "../store/merge-prefs.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { PrAutoFix } from "./pr-auto-fix.tsx";
import {
	compactMenuItemClass,
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

/** Manual repair stages the next message and remains available during an active turn. */
export function PrActionsMenu({
	executionRef,
	pr,
	details,
	sessionId,
	className,
	onView,
	onChat,
}: {
	executionRef: ExecutionRef;
	pr: GitPrInfo;
	details: GitPrDetails | null;
	sessionId: SessionId | null;
	className?: string;
	onView: () => void;
	onChat: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects", "chat"]);
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
	const addContextToChat = (scope: PrRepairScope, repairRequest = true) => {
		if (!sessionId || !details || !isSelectedChat()) return;
		const label = uiMessage(
			scope === "comments"
				? "projects:github_comments"
				: scope === "checks"
					? "projects:github_failing_checks"
					: scope === "conflicts"
						? "chat:right_pane_merge_conflicts"
						: "projects:github_everything",
		);
		useComposerDraftsStore.getState().addContext(
			composerDraftKeyForSession({
				environmentId: executionRef.environmentId,
				sessionId,
			}),
			{
				sourceKey: `${details.url}:${scope}:${repairRequest}`,
				label: `PR #${details.number} · ${label}`,
				text: repairRequest
					? prRepairDraft(details, scope)
					: prRepairMarkdown(details, scope),
			},
		);
		onChat();
		toastManager.add({
			type: "success",
			title: uiMessage("projects:pr_pane_added_to_the_composer", {
				relPath: `PR #${details.number} · ${label}`,
			}),
		});
	};
	const repair = (scope: PrRepairScope) => addContextToChat(scope);
	const comments = details
		? [...details.comments, ...details.reviews].filter((item) =>
				item.body.trim(),
			).length
		: 0;
	return (
		<Menu modal={false}>
			<MenuTrigger className={className}>
				<HugeiconsIcon
					icon={GitPullRequestIcon}
					className="size-[15px] shrink-0"
				/>
				<span className="min-w-0 flex-1 truncate">
					{details?.title ||
						uiMessage("projects:github_pr_number", { number: pr.number ?? "" })}
				</span>
				<HugeiconsIcon
					icon={ArrowDown01Icon}
					className="size-3 shrink-0 text-muted-foreground"
				/>
			</MenuTrigger>
			<MenuPopup side="left" align="start" sideOffset={8} className="w-60">
				<MenuItem className={compactMenuItemClass} onClick={onView}>
					<HugeiconsIcon icon={File01Icon} className="size-[15px]" />
					{uiMessage("projects:github_view_pr")}
				</MenuItem>
				<MenuSub>
					<MenuSubTrigger compact disabled={busy}>
						<HugeiconsIcon icon={Wrench01Icon} className="size-[15px]" />
						{uiMessage("projects:github_repair")}
						{comments + pr.checksFailing > 0 && (
							<span className="ml-auto tabular-nums text-destructive">
								{comments + pr.checksFailing}
							</span>
						)}
					</MenuSubTrigger>
					<MenuSubPopup className="w-52" sideOffset={4}>
						<MenuItem
							className={compactMenuItemClass}
							disabled={!details || !sessionId || comments === 0}
							onClick={() => void repair("comments")}
						>
							<HugeiconsIcon icon={Comment01Icon} />
							{uiMessage("projects:github_comments")}
							<span className="ml-auto">{comments}</span>
						</MenuItem>
						<MenuItem
							className={compactMenuItemClass}
							disabled={!details || !sessionId || pr.checks !== "failure"}
							onClick={() => void repair("checks")}
						>
							<HugeiconsIcon icon={CheckmarkCircle02Icon} />
							{uiMessage("projects:github_failing_checks")}
							<span className="ml-auto">{pr.checksFailing}</span>
						</MenuItem>
						<MenuItem
							className={compactMenuItemClass}
							disabled={
								!details || !sessionId || pr.mergeable !== "conflicting"
							}
							onClick={() => void repair("conflicts")}
						>
							<HugeiconsIcon icon={GitMergeConflictIcon} />
							{uiMessage("chat:right_pane_merge_conflicts")}
						</MenuItem>
						<MenuItem
							className={compactMenuItemClass}
							disabled={
								!details ||
								!sessionId ||
								(comments === 0 &&
									pr.checks !== "failure" &&
									pr.mergeable !== "conflicting")
							}
							onClick={() => void repair("everything")}
						>
							<HugeiconsIcon icon={Robot01Icon} />
							{uiMessage("projects:github_everything")}
						</MenuItem>
						<MenuSeparator className="mx-2 my-1 bg-foreground/10" />
						<PrAutoFix
							executionRef={executionRef}
							pr={pr}
							sessionId={sessionId}
							presentation="menu"
						/>
					</MenuSubPopup>
				</MenuSub>
				{pr.state === "open" && !pr.isDraft ? (
					<MenuSub>
						<MenuSubTrigger compact disabled={busy}>
							<HugeiconsIcon icon={GitMergeIcon} className="size-[15px]" />
							{uiMessage("chat:top_bar_merge")}
						</MenuSubTrigger>
						<MenuSubPopup className="w-52" sideOffset={4}>
							<MenuItem
								className={compactMenuItemClass}
								disabled={
									pr.mergeable !== "clean" ||
									pr.checks === "failure" ||
									pr.checks === "pending"
								}
								onClick={() => void merge("merge")}
							>
								<HugeiconsIcon icon={GitMergeIcon} />
								{uiMessage("chat:top_bar_merge")}
							</MenuItem>
							<MenuItem
								className={compactMenuItemClass}
								onClick={() =>
									void merge(
										pr.autoMergeEnabled ? "disable-auto" : "enable-auto",
									)
								}
							>
								<HugeiconsIcon icon={GitMergeIcon} />
								{pr.autoMergeEnabled
									? uiMessage("projects:github_disable_auto_merge")
									: uiMessage("projects:github_enable_auto_merge")}
							</MenuItem>
						</MenuSubPopup>
					</MenuSub>
				) : null}
				<MenuItem
					className={compactMenuItemClass}
					disabled={!details || !sessionId || busy}
					onClick={() => {
						if (details) addContextToChat("everything", false);
					}}
				>
					<HugeiconsIcon icon={CommentAdd01Icon} className="size-[15px]" />
					{uiMessage("projects:pr_pane_add_to_chat")}
				</MenuItem>
				<MenuSeparator className="mx-2 my-1 bg-foreground/10" />
				{pr.state !== "merged" ? (
					<MenuSub>
						<MenuSubTrigger compact disabled={busy}>
							<HugeiconsIcon icon={GitPullRequestDraftIcon} />
							{uiMessage("projects:github_status")}{" "}
							<span className="ml-auto truncate text-[11px] text-muted-foreground">
								{pr.state === "closed"
									? uiMessage("projects:pr_pane_closed")
									: pr.isDraft
										? uiMessage("projects:pr_pane_draft")
										: uiMessage("projects:github_ready_review")}
							</span>
						</MenuSubTrigger>
						<MenuSubPopup className="w-52" sideOffset={4}>
							<MenuItem
								className={compactMenuItemClass}
								disabled={pr.state !== "open" || pr.isDraft}
								onClick={() => void setStatus("draft")}
							>
								<HugeiconsIcon icon={GitPullRequestDraftIcon} />
								{uiMessage("projects:pr_pane_draft")}
							</MenuItem>
							<MenuItem
								className={compactMenuItemClass}
								disabled={pr.state !== "open" || !pr.isDraft}
								onClick={() => void setStatus("ready")}
							>
								<HugeiconsIcon icon={GitPullRequestIcon} />
								{uiMessage("projects:github_ready_review")}
							</MenuItem>
							<MenuItem
								className={compactMenuItemClass}
								onClick={() =>
									void setStatus(pr.state === "closed" ? "open" : "closed")
								}
							>
								<HugeiconsIcon
									icon={
										pr.state === "closed" ? GitPullRequestIcon : Cancel01Icon
									}
								/>
								{pr.state === "closed"
									? uiMessage("projects:github_reopen")
									: uiMessage("common:close")}
							</MenuItem>
						</MenuSubPopup>
					</MenuSub>
				) : null}
				<MenuItem
					className={compactMenuItemClass}
					disabled={!pr.url}
					onClick={() => {
						if (pr.url) void openExternal(pr.url);
					}}
				>
					<HugeiconsIcon icon={GithubIcon} className="size-[15px]" />
					{uiMessage("projects:github_open_github")}
				</MenuItem>
			</MenuPopup>
		</Menu>
	);
}
