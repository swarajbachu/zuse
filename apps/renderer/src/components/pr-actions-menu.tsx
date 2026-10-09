import "@zuse/i18n/english/chat";
import "@zuse/i18n/english/projects";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import type { GitPrDetails, GitPrInfo, SessionId } from "@zuse/contracts";
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
} from "@zuse/icons/solid-rounded";
import type { ReactNode } from "react";
import type { EnvironmentPrAction } from "../lib/branch-workflow.ts";
import { openExternal } from "../lib/platform-capabilities.ts";
import {
	type PrRepairScope,
	prRepairComposerTarget,
	prRepairDraft,
	prRepairFeedback,
	prRepairMarkdown,
} from "../lib/pr-repair.ts";
import { prMergeBlocker, usePrCommands } from "../lib/use-pr-commands.ts";
import {
	composerDraftKeyForSession,
	useComposerDraftsStore,
} from "../store/composer-drafts.ts";
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
import { Spinner } from "./ui/spinner.tsx";
import { toastManager } from "./ui/toast.tsx";

const prActionToneClass: Record<EnvironmentPrAction, string> = {
	resolve: "text-[var(--accent-red)] hover:bg-[var(--accent-red)]/10",
	fix: "text-[var(--accent-red)] hover:bg-[var(--accent-red)]/10",
	ready: "text-foreground hover:bg-muted",
	merge: "text-[var(--accent-green)] hover:bg-[var(--accent-green)]/10",
};

/**
 * Manual repair stages the next message and remains available during an active turn.
 * `action` adds the one ranked next step (see `deriveEnvironmentPrRows`) beside the row.
 */
export function PrActionsMenu({
	executionRef,
	pr,
	details,
	sessionId,
	action = null,
	className,
	trigger,
	popupSide = "left",
	onView,
	onChat,
}: {
	executionRef: ExecutionRef;
	pr: GitPrInfo;
	details: GitPrDetails | null;
	sessionId: SessionId | null;
	action?: EnvironmentPrAction | null;
	className?: string;
	/** Replaces the default title trigger, e.g. with a compact "…" button. */
	trigger?: ReactNode;
	popupSide?: "left" | "bottom";
	/** Omitted where the PR view is already visible. */
	onView?: () => void;
	onChat: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects", "chat"]);
	const { busy, setStatus, merge } = usePrCommands(executionRef);
	const addContextToChat = (scope: PrRepairScope, repairRequest = true) => {
		if (!sessionId || !details) return;
		const target = prRepairComposerTarget(
			executionRef,
			sessionId,
			useSessionsStore.getState().selectedSessionId,
		);
		if (target === null) {
			toastManager.add({
				type: "error",
				title: uiMessage("projects:github_repair_state_changed"),
			});
			return;
		}
		const label = uiMessage(
			scope === "comments"
				? "projects:github_comments"
				: scope === "checks"
					? "projects:github_failing_checks"
					: scope === "conflicts"
						? "chat:right_pane_merge_conflicts"
						: "projects:github_everything",
		);
		useComposerDraftsStore
			.getState()
			.addContext(composerDraftKeyForSession(target), {
				sourceKey: `${details.url}:${scope}:${repairRequest}`,
				label: `PR #${details.number} · ${label}`,
				text: repairRequest
					? prRepairDraft(details, scope)
					: prRepairMarkdown(details, scope),
			});
		onChat();
		toastManager.add({
			type: "success",
			title: uiMessage("projects:pr_pane_added_to_the_composer", {
				relPath: `PR #${details.number} · ${label}`,
			}),
		});
	};
	const repair = (scope: PrRepairScope) => addContextToChat(scope);
	const comments = details ? prRepairFeedback(details).length : 0;
	const rowAction =
		action === null
			? null
			: {
					resolve: {
						label: uiMessage("projects:pr_pane_resolve"),
						title: uiMessage("chat:top_bar_resolve_conflicts"),
						disabled: !details || !sessionId,
						run: () => repair("conflicts"),
					},
					fix: {
						label: uiMessage("chat:top_bar_fix"),
						title: uiMessage("projects:github_failing_checks"),
						disabled: !details || !sessionId,
						run: () => repair("checks"),
					},
					ready: {
						label: uiMessage("chat:top_bar_mark_ready"),
						title: uiMessage("projects:github_ready_review"),
						disabled: busy,
						run: () => void setStatus("ready"),
					},
					merge: {
						label: uiMessage("chat:top_bar_merge"),
						title: uiMessage("chat:top_bar_merge"),
						disabled: busy,
						run: () => void merge("merge"),
					},
				}[action];
	return (
		<Menu modal={false}>
			{trigger !== undefined ? (
				<MenuTrigger className={className}>{trigger}</MenuTrigger>
			) : (
				<div className={className}>
					<MenuTrigger className="flex min-h-7 min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
						<HugeiconsIcon
							icon={pr.isDraft ? GitPullRequestDraftIcon : GitPullRequestIcon}
							className="size-4 shrink-0 text-muted-foreground"
						/>
						<span className="min-w-0 flex-1 truncate">
							{details?.title ||
								uiMessage("projects:github_pr_number", {
									number: pr.number ?? "",
								})}
						</span>
						{rowAction === null ? (
							<HugeiconsIcon
								icon={ArrowDown01Icon}
								className="size-3 shrink-0 text-muted-foreground"
							/>
						) : null}
					</MenuTrigger>
					{action !== null && rowAction !== null ? (
						<button
							type="button"
							title={rowAction.title}
							disabled={rowAction.disabled}
							onClick={rowAction.run}
							className={`inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-40 ${prActionToneClass[action]}`}
						>
							{busy && (action === "merge" || action === "ready") ? (
								<Spinner className="size-3" />
							) : null}
							{rowAction.label}
						</button>
					) : null}
				</div>
			)}
			<MenuPopup
				side={popupSide}
				align={popupSide === "left" ? "start" : "end"}
				sideOffset={popupSide === "left" ? 8 : 4}
				className="w-60"
			>
				{onView ? (
					<MenuItem className={compactMenuItemClass} onClick={onView}>
						<HugeiconsIcon icon={File01Icon} className="size-[15px]" />
						{uiMessage("projects:github_view_pr")}
					</MenuItem>
				) : null}
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
								disabled={prMergeBlocker(pr) !== null}
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
