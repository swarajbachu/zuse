import { formatDate as formatUiDate } from "@zuse/i18n";
import { isHttpUrl, openHttpLink as openExternal } from "../lib/http-links.ts";
import {
	checkKind,
	countChecks,
	sortChecks,
	summarizeChecks,
} from "../lib/pr-checks.ts";
import { useGitPrState } from "../lib/use-git-pr-state.ts";
import { GitHubAvatar } from "./github-avatar.tsx";
import { MarkdownBody } from "./markdown-body.tsx";
import "@zuse/i18n/english/chat";
import "@zuse/i18n/english/projects";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import type {
	GitPrCheckRun,
	GitPrComment,
	GitPrDetails,
	GitPrReview,
	GitPrReviewState,
} from "@zuse/contracts";
import { GitPrInfo } from "@zuse/contracts";
import { RichMessage, useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	ArrowUpRight01Icon,
	CommentAdd01Icon,
	GitBranchIcon,
	GitMergeIcon,
	GitPullRequestClosedIcon,
	GitPullRequestDraftIcon,
	GitPullRequestIcon,
	MoreHorizontalIcon,
	Tick01Icon,
	UserMultipleIcon,
} from "@zuse/icons/solid-rounded";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "~/lib/utils";
import {
	attachFileWhenReady,
	saveContextFile,
} from "../lib/context-handoff.ts";
import { refreshGitPrDetails } from "../lib/git-workspace-client-bus.ts";
import { prRepairMarkdown } from "../lib/pr-repair.ts";
import {
	type PrMergeBlocker,
	prMergeBlocker,
	usePrCommands,
} from "../lib/use-pr-commands.ts";
import { useComposerBridge } from "../store/composer-bridge.ts";
import {
	composerDraftKeyForSession,
	useComposerDraftsStore,
} from "../store/composer-drafts.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { CheckStatusIcon, ChecksRing } from "./dock-panel/checks.tsx";
import { DiffStat } from "./dock-panel/diff-stat.tsx";
import {
	DockDisclosureSection,
	DockMetaRow,
	DockWarningNote,
} from "./dock-panel/section.tsx";
import {
	DOCK_BODY_CLASS,
	DOCK_ICON_BUTTON_CLASS,
	DOCK_META_CLASS,
	DOCK_ROW_CLASS,
	DOCK_TITLE_CLASS,
} from "./dock-panel/text.ts";
import { GitInitCta } from "./git-init-cta.tsx";
import { PrActionsMenu } from "./pr-actions-menu.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { Spinner } from "./ui/spinner.tsx";
import { toastManager } from "./ui/toast.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

/** Checks beyond this stay behind "Show all" so feedback remains reachable. */
const VISIBLE_CHECK_LIMIT = 8;

const formatRelative = (date: Date): string => {
	const diffMs = Date.now() - date.getTime();
	const sec = Math.round(diffMs / 1000);
	if (sec < 60) return "just now";
	const min = Math.round(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.round(hr / 24);
	if (day < 30) return `${day}d ago`;
	return formatUiDate(date);
};

type PrMarkdownContext = {
	readonly number: number | null;
	readonly title: string;
	readonly url: string | null;
};

const formatAbsolute = (date: Date | null): string =>
	date === null ? "unknown" : date.toISOString();

const reviewStateLabel = (state: GitPrReviewState): string => {
	if (state === "approved") return "Approved";
	if (state === "changes_requested") return "Changes requested";
	if (state === "dismissed") return "Dismissed";
	if (state === "pending") return "Pending";
	return "Commented";
};

const prMarkdownHeader = (pr: PrMarkdownContext): string => {
	const lines = ["# PR feedback"];
	const title = pr.title.trim().length > 0 ? pr.title.trim() : "(no title)";
	if (pr.number !== null) lines.push(`- PR: #${pr.number} ${title}`);
	else lines.push(`- PR: ${title}`);
	if (pr.url !== null) lines.push(`- URL: ${pr.url}`);
	return `${lines.join("\n")}\n`;
};

const isVisibleReview = (review: GitPrReview): boolean =>
	review.state !== "pending" &&
	(review.state !== "commented" || review.body.trim().length > 0);

const prInfoFromDetails = (details: GitPrDetails): GitPrInfo => {
	const counts = summarizeChecks(details.checkRuns);
	return GitPrInfo.make({
		state: details.state,
		branch: details.headBranch,
		baseBranch: details.baseBranch,
		additions: details.additions,
		deletions: details.deletions,
		number: details.number,
		url: details.url,
		isDraft: details.isDraft,
		...counts,
		checkRuns: details.checkRuns,
		mergeable: details.mergeable,
		autoMergeEnabled: false,
	});
};

const markdownForReview = (
	pr: PrMarkdownContext,
	review: Pick<
		GitPrReview,
		"author" | "state" | "body" | "submittedAt" | "url"
	>,
): string =>
	`${prMarkdownHeader(pr)}
## Review
- Author: ${review.author}
- State: ${reviewStateLabel(review.state)}
- Submitted: ${formatAbsolute(review.submittedAt)}
${review.url ? `- Link: ${review.url}` : ""}

${review.body.trim().length > 0 ? review.body.trim() : "(no review body)"}
`;

const markdownForComment = (
	pr: PrMarkdownContext,
	comment: GitPrComment,
): string =>
	`${prMarkdownHeader(pr)}
## Comment
- Author: ${comment.author}
- Created: ${formatAbsolute(comment.createdAt)}
${comment.url ? `- Link: ${comment.url}` : ""}
${comment.path ? `- File: ${comment.path}:${comment.line ?? ""}` : ""}
${comment.diffHunk ? `\n\`\`\`diff\n${comment.diffHunk}\n\`\`\`\n` : ""}

${comment.body.trim().length > 0 ? comment.body.trim() : "(no comment body)"}
`;

/**
 * Right-pane "PR" tab. Title, state, description, reviews, comments, and CI
 * checks for the branch's open PR. Files-changed lives in the Changes tab.
 * Worktree-aware — each worktree has its own branch and PR, so all
 * lookups + the lazy details fetch are keyed by `(folderId, worktreeId)`.
 */
export function PrPane({
	executionRef,
}: {
	executionRef: ExecutionRef | null;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	const {
		gitView: workspaceView,
		prDetailsView: detailsView,
		pr,
		details,
	} = useGitPrState(executionRef, true);
	const status = workspaceView.data?.status ?? null;
	const noRepo = workspaceView.data?.noRepository === true;
	const detailsLoading = detailsView.sync === "synchronizing";

	if (executionRef === null) {
		return (
			<Empty>
				{uiMessage("projects:pr_pane_select_a_project_to_see_its_pr_here")}
			</Empty>
		);
	}
	if (noRepo) {
		return (
			<div className="flex min-h-0 flex-1 flex-col px-4 py-3 text-xs">
				<GitInitCta executionRef={executionRef} />
			</div>
		);
	}
	if (status === null) {
		return <Empty>{uiMessage("projects:pr_pane_reading_branch_state")}</Empty>;
	}

	const detailsPr =
		details !== null && details.state !== "none"
			? prInfoFromDetails(details)
			: null;
	const effectivePr = pr !== null && pr.state !== "none" ? pr : detailsPr;
	const refreshError = detailsView.data?.error ? (
		<DockWarningNote
			className="mx-4 mb-2"
			action={
				<button
					type="button"
					className="h-6 shrink-0 rounded-md px-2 text-[11px] font-medium text-foreground hover:bg-muted/60 disabled:opacity-50"
					disabled={detailsLoading}
					onClick={() => void refreshGitPrDetails(executionRef)}
				>
					{uiMessage("common:retry")}
				</button>
			}
		>
			{uiMessage("projects:github_refresh_failed")}{" "}
			<span className="text-muted-foreground">
				{detailsView.data.error.message}
			</span>
		</DockWarningNote>
	) : null;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{effectivePr === null ? (
				<div className="min-h-0 flex-1 overflow-y-auto pt-3">
					{refreshError}
					<NoPrState
						branch={status.branch}
						dirtyFiles={status.dirtyFiles}
						ahead={status.ahead}
					/>
				</div>
			) : (
				<PrOverview
					executionRef={executionRef}
					pr={effectivePr}
					details={details}
					detailsLoading={detailsLoading}
					banner={refreshError}
				/>
			)}
		</div>
	);
}

function NoPrState({
	branch,
	dirtyFiles,
	ahead,
}: {
	branch: string | null;
	dirtyFiles: number;
	ahead: number;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	return (
		<section className="px-4 pb-4">
			<p className={DOCK_TITLE_CLASS}>
				{uiMessage("projects:pr_pane_no_pull_request")}
			</p>
			<p className={cn("mt-1", DOCK_META_CLASS)}>
				{uiMessage("projects:pr_pane_no_pull_request_open_for_this_branch")}
			</p>
			<div className="mt-3">
				<DockMetaRow
					icon={<HugeiconsIcon icon={GitBranchIcon} className="size-3.5" />}
					label={uiMessage("projects:pr_pane_branch")}
				>
					<span className="truncate font-mono text-[11px]">
						{branch ?? uiMessage("projects:pr_pane_detached")}
					</span>
				</DockMetaRow>
				<DockMetaRow label={uiMessage("projects:pr_pane_local_changes")}>
					{dirtyFiles > 0 ? (
						<span className="text-[var(--accent-amber)]">
							{uiMessage("projects:pr_pane_file_plural0_sentence", {
								dirtyFiles: dirtyFiles ?? "",
								count: dirtyFiles,
							})}
						</span>
					) : (
						<span className="text-muted-foreground">
							{uiMessage("projects:pr_pane_clean")}
						</span>
					)}
				</DockMetaRow>
				<DockMetaRow label={uiMessage("projects:pr_pane_ahead_of_upstream")}>
					{ahead > 0 ? (
						<span>
							{uiMessage("projects:pr_pane_commit_plural0_sentence", {
								ahead: ahead ?? "",
								count: ahead,
							})}
						</span>
					) : (
						<span className="text-muted-foreground">
							{uiMessage("projects:pr_pane_in_sync")}
						</span>
					)}
				</DockMetaRow>
			</div>
		</section>
	);
}

export function PrOverview({
	executionRef,
	pr,
	details,
	detailsLoading,
	banner,
}: {
	executionRef: ExecutionRef;
	pr: GitPrInfo;
	details: GitPrDetails | null;
	detailsLoading: boolean;
	banner?: ReactNode;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	const title = details?.title ?? "";
	const body = details?.body ?? "";
	const headBranch = details?.headBranch ?? pr.branch;
	const baseBranch = details?.baseBranch ?? pr.baseBranch;
	const additions = details?.additions ?? pr.additions;
	const deletions = details?.deletions ?? pr.deletions;
	const url = details?.url ?? pr.url;
	const number = details?.number ?? pr.number;
	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
	const setActiveMainTab = useUiStore((s) => s.setActiveMainTab);
	const composerDraft = useComposerDraftsStore((s) =>
		selectedSessionId === null
			? null
			: (s.draftsByKey[
					composerDraftKeyForSession({
						environmentId: executionRef.environmentId,
						sessionId: selectedSessionId,
					})
				] ?? null),
	);
	const composerFilePaths = useMemo(() => {
		const paths = new Set<string>();
		for (const chip of composerDraft?.chips ?? []) {
			if (chip.meta.kind === "file") paths.add(chip.meta.relPath);
		}
		return paths;
	}, [composerDraft, uiMessage]);
	const [feedbackFilesByKey, setFeedbackFilesByKey] = useState<
		Record<string, string>
	>({});

	// Failing checks first — that's what the user opened the tab to investigate.
	const orderedChecks = sortChecks(details?.checkRuns ?? pr.checkRuns ?? []);
	const attachMarkdown = async (
		markdown: string,
		label: string,
		options: { toast?: boolean } = {},
	): Promise<string | null> => {
		if (selectedSessionId === null) {
			toastManager.add({
				type: "error",
				title: uiMessage("projects:pr_pane_no_active_chat"),
				description: uiMessage(
					"projects:pr_pane_open_a_chat_before_attaching_pr_feedback",
				),
			});
			return null;
		}
		const ref = await saveContextFile(
			executionRef.environmentId,
			selectedSessionId,
			markdown,
		);
		if (ref === null) {
			toastManager.add({
				type: "error",
				title: uiMessage("projects:pr_pane_couldn_t_attach_feedback"),
				description: uiMessage(
					"projects:pr_pane_the_pr_feedback_file_could_not_be_created",
				),
			});
			return null;
		}
		setActiveMainTab("chat");
		attachFileWhenReady(ref, 20, 50, {
			environmentId: executionRef.environmentId,
			sessionId: selectedSessionId,
		});
		setTimeout(() => useComposerBridge.getState().focus?.(), 75);
		if (options.toast !== false) {
			toastManager.add({
				type: "success",
				title: uiMessage("projects:pr_pane_attached", { label: String(label) }),
				description: uiMessage("projects:pr_pane_added_to_the_composer", {
					relPath: String(ref.relPath),
				}),
			});
		}
		return ref.relPath;
	};
	const prContext = {
		number,
		title,
		url,
	};
	const visibleReviews = details?.reviews.filter(isVisibleReview) ?? [];
	const comments = details?.comments ?? [];
	const feedbackCount = visibleReviews.length + comments.length;
	const reviewKey = (review: GitPrReview, idx: number) =>
		`review:${idx}:${review.author}:${review.submittedAt?.toISOString() ?? ""}`;
	const commentKey = (comment: GitPrComment, idx: number) =>
		`comment:${idx}:${comment.author}:${comment.createdAt.toISOString()}`;
	const feedbackAttached = (key: string): boolean => {
		const path = feedbackFilesByKey[key];
		return path !== undefined && composerFilePaths.has(path);
	};
	const rememberFeedbackFile = (key: string, relPath: string) =>
		setFeedbackFilesByKey((prev) => ({ ...prev, [key]: relPath }));
	const attachFeedbackItem = async (
		key: string,
		markdown: string,
		label: string,
		options?: { toast?: boolean },
	) => {
		const relPath = await attachMarkdown(markdown, label, options);
		if (relPath !== null) rememberFeedbackFile(key, relPath);
		return relPath !== null;
	};
	const resolveMarkdown = (markdown: string): string =>
		`${markdown.trim()}

## Requested action
Resolve this PR feedback. Make the necessary code changes, then summarize what changed.
`;
	const attachAllFeedback = async () => {
		if (details === null) return;
		const path = await attachMarkdown(
			prRepairMarkdown(details, "comments"),
			"PR feedback",
		);
		if (path === null) return;
		setFeedbackFilesByKey((previous) => ({
			...previous,
			...Object.fromEntries([
				...visibleReviews.map((review, index) => [
					reviewKey(review, index),
					path,
				]),
				...comments.map((comment, index) => [commentKey(comment, index), path]),
			]),
		}));
	};

	const allFeedbackAttached =
		feedbackCount > 0 &&
		visibleReviews.every((review, idx) =>
			feedbackAttached(reviewKey(review, idx)),
		) &&
		comments.every((comment, idx) =>
			feedbackAttached(commentKey(comment, idx)),
		);

	const [showAllChecks, setShowAllChecks] = useState(false);
	const checkCounts = countChecks(orderedChecks);
	const visibleChecks = showAllChecks
		? orderedChecks
		: orderedChecks.slice(0, VISIBLE_CHECK_LIMIT);
	const latestReviews = latestReviewByAuthor(visibleReviews);

	return (
		<>
			<PrHeader
				executionRef={executionRef}
				pr={pr}
				details={details}
				number={number}
				url={url}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{banner}
				<section className="px-4 pb-3">
					<h1 className={cn("break-words", DOCK_TITLE_CLASS)}>
						{title ||
							uiMessage("projects:github_pr_number", {
								number: number ?? "",
							})}
					</h1>
					<div
						className={cn("mt-1.5 flex items-center gap-1.5", DOCK_META_CLASS)}
					>
						{details?.author ? (
							<>
								<GitHubAvatar
									name={details.author}
									url={details.authorAvatarUrl}
									className="size-4"
								/>
								<span className="truncate font-medium text-foreground/90">
									{details.author}
								</span>
								<span aria-hidden="true">·</span>
							</>
						) : null}
						<DiffStat additions={additions} deletions={deletions} />
					</div>
					<div className="mt-2.5">
						<DockMetaRow
							icon={<HugeiconsIcon icon={GitBranchIcon} className="size-3.5" />}
							label={uiMessage("projects:pr_pane_branch")}
						>
							<span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px]">
								<span className="truncate">{headBranch}</span>
								<span className="shrink-0 text-muted-foreground">›</span>
								<span className="truncate text-muted-foreground">
									{baseBranch}
								</span>
							</span>
						</DockMetaRow>
						{pr.mergeable === "conflicting" && pr.state === "open" ? (
							<DockMetaRow
								icon={
									<HugeiconsIcon icon={GitMergeIcon} className="size-3.5" />
								}
								label={uiMessage("chat:top_bar_merge")}
							>
								<span className="text-[var(--accent-red)]">
									{uiMessage("projects:pr_pane_conflicts_with_base")}
								</span>
							</DockMetaRow>
						) : null}
						{latestReviews.length > 0 ? (
							<DockMetaRow
								icon={
									<HugeiconsIcon icon={UserMultipleIcon} className="size-3.5" />
								}
								label={uiMessage("projects:pr_pane_reviews")}
							>
								{latestReviews.map((review) => (
									<span
										key={review.author}
										className="flex min-w-0 items-center gap-1.5"
									>
										<GitHubAvatar
											name={review.author}
											url={review.authorAvatarUrl}
											className="size-4"
										/>
										<ReviewStateLabel state={review.state} />
									</span>
								))}
							</DockMetaRow>
						) : null}
						<DockMetaRow
							icon={<ChecksRing counts={checkCounts} />}
							label={uiMessage("projects:pr_pane_checks")}
						>
							<span
								className={
									checkCounts.failure > 0
										? "text-[var(--accent-red)]"
										: checkCounts.total === 0
											? "text-muted-foreground"
											: undefined
								}
							>
								{pr.isDraft && checkCounts.total === 0
									? uiMessage("projects:pr_pane_draft_checks_hint")
									: checkSummaryText(checkCounts, uiMessage)}
							</span>
						</DockMetaRow>
					</div>
				</section>

				{detailsLoading && details === null ? (
					<div className="space-y-2.5 border-t border-border/50 px-4 py-4">
						<Skeleton className="h-3 w-1/3" />
						<Skeleton className="h-3 w-4/5" />
						<Skeleton className="h-3 w-3/5" />
					</div>
				) : details === null ? (
					<div className="border-t border-border/50 px-4 py-3">
						<DockWarningNote>
							<RichMessage
								id="projects:pr_pane_gh_couldn_t_read_pr_details_sentence"
								components={{ part0: <code className="font-mono" /> }}
								values={{ code0: "gh" }}
							/>
						</DockWarningNote>
					</div>
				) : (
					<>
						<DockDisclosureSection
							label={uiMessage("projects:pr_pane_description")}
						>
							{body.trim().length > 0 ? (
								<ClampedDescription text={body} />
							) : (
								<p className={DOCK_META_CLASS}>
									{uiMessage("projects:pr_pane_no_description")}
								</p>
							)}
						</DockDisclosureSection>

						{orderedChecks.length > 0 ? (
							<DockDisclosureSection
								label={uiMessage("projects:pr_pane_checks")}
								count={orderedChecks.length}
							>
								<ul className="flex flex-col">
									{visibleChecks.map((run, idx) => (
										<CheckRunRow key={`${run.name}-${idx}`} run={run} />
									))}
								</ul>
								{orderedChecks.length > VISIBLE_CHECK_LIMIT ? (
									<button
										type="button"
										onClick={() => setShowAllChecks((value) => !value)}
										className="mt-1 h-6 text-[11px] font-medium text-muted-foreground hover:text-foreground"
									>
										{showAllChecks
											? uiMessage("projects:pr_pane_show_fewer")
											: uiMessage("projects:pr_pane_show_all", {
													total: String(orderedChecks.length),
												})}
									</button>
								) : null}
							</DockDisclosureSection>
						) : null}

						{feedbackCount > 0 ? (
							<DockDisclosureSection
								label={uiMessage("projects:pr_pane_feedback_title")}
								count={feedbackCount}
								action={
									<AttachButton
										label={uiMessage(
											"projects:pr_pane_add_all_feedback_to_chat",
										)}
										onClick={() => void attachAllFeedback()}
										attached={allFeedbackAttached}
									>
										{uiMessage("projects:pr_pane_add_all")}
									</AttachButton>
								}
							>
								<div className="flex flex-col gap-0.5">
									{visibleReviews.map((r, idx) => {
										const key = reviewKey(r, idx);
										const markdown = markdownForReview(prContext, r);
										const resolveKey = `${key}:resolve`;
										return (
											<FeedbackReviewRow
												key={key}
												author={r.author}
												authorAvatarUrl={r.authorAvatarUrl ?? null}
												url={r.url ?? null}
												state={r.state}
												body={r.body}
												submittedAt={r.submittedAt}
												attached={feedbackAttached(key)}
												resolveAttached={feedbackAttached(resolveKey)}
												onAttach={() =>
													void attachFeedbackItem(key, markdown, "Review")
												}
												onResolve={() =>
													void attachFeedbackItem(
														resolveKey,
														resolveMarkdown(markdown),
														"Resolution request",
													)
												}
											/>
										);
									})}
									{comments.map((c, idx) => {
										const key = commentKey(c, idx);
										const markdown = markdownForComment(prContext, c);
										const resolveKey = `${key}:resolve`;
										return (
											<FeedbackCommentRow
												key={key}
												author={c.author}
												authorAvatarUrl={c.authorAvatarUrl ?? null}
												url={c.url ?? null}
												path={c.path ?? null}
												line={c.line ?? null}
												body={c.body}
												createdAt={c.createdAt}
												attached={feedbackAttached(key)}
												resolveAttached={feedbackAttached(resolveKey)}
												onAttach={() =>
													void attachFeedbackItem(key, markdown, "Comment")
												}
												onResolve={() =>
													void attachFeedbackItem(
														resolveKey,
														resolveMarkdown(markdown),
														"Resolution request",
													)
												}
											/>
										);
									})}
								</div>
							</DockDisclosureSection>
						) : null}
					</>
				)}
			</div>
		</>
	);
}

type UiMessage = ReturnType<typeof useUiMessages>["message"];

/** Most decisive state wins the one-line rollup: failures, then progress. */
function checkSummaryText(
	counts: ReturnType<typeof countChecks>,
	uiMessage: UiMessage,
): string {
	if (counts.total === 0)
		return uiMessage("projects:pr_pane_no_checks_configured");
	if (counts.failure === 0 && counts.pending === 0)
		return uiMessage("projects:pr_pane_all_checks_passed");
	const parts: string[] = [];
	if (counts.failure > 0)
		parts.push(
			uiMessage("projects:pr_pane_failing_sentence", { value: counts.failure }),
		);
	if (counts.pending > 0)
		parts.push(
			uiMessage("projects:pr_pane_running_sentence", { value: counts.pending }),
		);
	if (counts.success > 0)
		parts.push(
			uiMessage("projects:pr_pane_passed_sentence", { value: counts.success }),
		);
	return parts.join(" · ");
}

/** A reviewer's current stance is their latest submitted review. */
function latestReviewByAuthor(reviews: readonly GitPrReview[]): GitPrReview[] {
	const latest = new Map<string, GitPrReview>();
	for (const review of reviews) {
		const previous = latest.get(review.author);
		if (
			previous === undefined ||
			(review.submittedAt?.getTime() ?? 0) >=
				(previous.submittedAt?.getTime() ?? 0)
		)
			latest.set(review.author, review);
	}
	return [...latest.values()];
}

function PrStateBadge({ pr }: { pr: GitPrInfo }) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);
	const state = pr.isDraft
		? {
				icon: GitPullRequestDraftIcon,
				label: uiMessage("projects:pr_pane_draft"),
				className: "text-muted-foreground",
			}
		: pr.state === "merged"
			? {
					icon: GitMergeIcon,
					label: uiMessage("projects:pr_pane_merged"),
					className: "text-violet-500 dark:text-violet-400",
				}
			: pr.state === "closed"
				? {
						icon: GitPullRequestClosedIcon,
						label: uiMessage("projects:pr_pane_closed"),
						className: "text-[var(--accent-red)]",
					}
				: {
						icon: GitPullRequestIcon,
						label: uiMessage("common:open"),
						className: "text-[var(--accent-green)]",
					};
	return (
		<span
			className={cn(
				"inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_srgb,currentColor_12%,transparent)] px-2 text-[11px] font-medium",
				state.className,
			)}
		>
			<HugeiconsIcon icon={state.icon} className="size-3" />
			{state.label}
		</span>
	);
}

function PrHeader({
	executionRef,
	pr,
	details,
	number,
	url,
}: {
	executionRef: ExecutionRef;
	pr: GitPrInfo;
	details: GitPrDetails | null;
	number: number | null;
	url: string | null;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects", "chat"]);
	const sessionId = useSessionsStore((s) => s.selectedSessionId);
	const commands = usePrCommands(executionRef);
	return (
		<header className="flex h-11 shrink-0 items-center gap-2 px-4">
			<PrStateBadge pr={pr} />
			{number !== null ? (
				<span className="tabular-nums text-[11px] text-muted-foreground">
					#{number}
				</span>
			) : null}
			<div className="ml-auto flex shrink-0 items-center gap-0.5">
				{url ? (
					<button
						type="button"
						aria-label={uiMessage("projects:github_open_github")}
						title={uiMessage("projects:github_open_github")}
						onClick={() => openExternal(url)}
						className={DOCK_ICON_BUTTON_CLASS}
					>
						<HugeiconsIcon icon={ArrowUpRight01Icon} className="size-4" />
					</button>
				) : null}
				<PrActionsMenu
					executionRef={executionRef}
					pr={pr}
					details={details}
					sessionId={sessionId}
					className={DOCK_ICON_BUTTON_CLASS}
					popupSide="bottom"
					trigger={
						<HugeiconsIcon
							icon={MoreHorizontalIcon}
							className="size-4"
							aria-label={uiMessage("projects:pr_pane_more_actions")}
						/>
					}
					onChat={() => useUiStore.getState().setActiveMainTab("chat")}
				/>
				<PrPrimaryAction pr={pr} commands={commands} />
			</div>
		</header>
	);
}

const PRIMARY_BUTTON_CLASS =
	"ml-1 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring";

function mergeBlockerMessage(
	blocker: PrMergeBlocker,
	uiMessage: UiMessage,
): string {
	switch (blocker) {
		case "conflicts":
			return uiMessage("projects:pr_pane_merge_blocked_conflicts");
		case "checks-failing":
			return uiMessage("projects:pr_pane_merge_blocked_checks_failing");
		case "checks-running":
			return uiMessage("projects:pr_pane_merge_blocked_checks_running");
		case "not-mergeable":
			return uiMessage("projects:pr_pane_merge_blocked_not_mergeable");
	}
}

/** The one next step for an open PR: publish a draft, or merge. */
function PrPrimaryAction({
	pr,
	commands,
}: {
	pr: GitPrInfo;
	commands: ReturnType<typeof usePrCommands>;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects", "chat"]);
	if (pr.state !== "open") return null;
	if (pr.isDraft) {
		return (
			<button
				type="button"
				disabled={commands.busy}
				onClick={() => void commands.setStatus("ready")}
				className={cn(
					PRIMARY_BUTTON_CLASS,
					"bg-muted text-foreground hover:bg-muted/70 disabled:opacity-60",
				)}
			>
				{commands.pending === "ready" ? <Spinner className="size-3.5" /> : null}
				{uiMessage("projects:github_ready_review")}
			</button>
		);
	}
	const blocker = prMergeBlocker(pr);
	if (blocker !== null) {
		return (
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							type="button"
							aria-disabled
							className={cn(
								PRIMARY_BUTTON_CLASS,
								"cursor-default bg-muted/60 text-muted-foreground",
							)}
						>
							<HugeiconsIcon icon={GitMergeIcon} className="size-3.5" />
							{uiMessage("chat:top_bar_merge")}
						</button>
					}
				/>
				<TooltipPopup>{mergeBlockerMessage(blocker, uiMessage)}</TooltipPopup>
			</Tooltip>
		);
	}
	return (
		<button
			type="button"
			disabled={commands.busy}
			onClick={() => void commands.merge("merge")}
			className={cn(
				PRIMARY_BUTTON_CLASS,
				"bg-foreground text-background hover:bg-foreground/85 disabled:opacity-60",
			)}
		>
			{commands.pending === "merge" ? (
				<Spinner className="size-3.5" />
			) : (
				<HugeiconsIcon icon={GitMergeIcon} className="size-3.5" />
			)}
			{commands.pending === "merge"
				? uiMessage("projects:pr_pane_merging")
				: uiMessage("chat:top_bar_merge")}
		</button>
	);
}

/** Collapsed height for long PR descriptions; checks and feedback stay in view. */
const DESCRIPTION_CLAMP_PX = 112;

function ClampedDescription({ text }: { text: string }) {
	const { message: uiMessage } = useUiMessages(["projects"]);
	const contentRef = useRef<HTMLDivElement>(null);
	const [overflows, setOverflows] = useState(false);
	const [expanded, setExpanded] = useState(false);
	useEffect(() => {
		const node = contentRef.current;
		if (node === null) return;
		const measure = () =>
			setOverflows(node.scrollHeight > DESCRIPTION_CLAMP_PX + 8);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);
	const clamped = overflows && !expanded;
	return (
		<div>
			<div
				className="overflow-hidden"
				style={
					clamped
						? {
								maxHeight: DESCRIPTION_CLAMP_PX,
								maskImage: "linear-gradient(to bottom, black 60%, transparent)",
							}
						: undefined
				}
			>
				<div ref={contentRef}>
					<PlainTextPreview text={text} />
				</div>
			</div>
			{overflows ? (
				<button
					type="button"
					onClick={() => setExpanded((value) => !value)}
					className="mt-1 h-6 text-[11px] font-medium text-muted-foreground hover:text-foreground"
				>
					{expanded
						? uiMessage("projects:pr_pane_show_less")
						: uiMessage("projects:pr_pane_show_more")}
				</button>
			) : null}
		</div>
	);
}

function PlainTextPreview({ text }: { text: string }) {
	return (
		<MarkdownBody githubHtml className={DOCK_BODY_CLASS}>
			{text}
		</MarkdownBody>
	);
}

function FeedbackActions({
	url,
	attached,
	resolveAttached,
	attachLabel,
	resolveLabel,
	onAttach,
	onResolve,
}: {
	url: string | null;
	attached: boolean;
	resolveAttached: boolean;
	attachLabel: string;
	resolveLabel: string;
	onAttach: () => void;
	onResolve: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);
	return (
		<div
			className={cn(
				"ml-auto shrink-0 items-center gap-0.5",
				attached || resolveAttached
					? "flex"
					: "hidden group-hover:flex group-focus-within:flex",
			)}
		>
			<AttachButton
				label={resolveLabel}
				attached={resolveAttached}
				onClick={onResolve}
			>
				{uiMessage("projects:pr_pane_resolve")}
			</AttachButton>
			<AttachButton label={attachLabel} attached={attached} onClick={onAttach}>
				{attached
					? uiMessage("projects:pr_pane_added")
					: uiMessage("projects:pr_pane_add_to_chat")}
			</AttachButton>
			{url ? (
				<button
					type="button"
					aria-label={uiMessage("projects:github_open_github")}
					title={uiMessage("projects:github_open_github")}
					onClick={() => openExternal(url)}
					className={cn(DOCK_ICON_BUTTON_CLASS, "size-6")}
				>
					<HugeiconsIcon icon={ArrowUpRight01Icon} className="size-3.5" />
				</button>
			) : null}
		</div>
	);
}

const FEEDBACK_ROW_CLASS =
	"group -mx-2 flex min-w-0 items-start gap-2 rounded-md px-2 py-2 transition-colors hover:bg-muted/40";

function FeedbackReviewRow({
	author,
	authorAvatarUrl,
	url,
	state,
	body,
	submittedAt,
	attached,
	resolveAttached,
	onAttach,
	onResolve,
}: {
	author: string;
	authorAvatarUrl: string | null;
	url: string | null;
	state: GitPrReviewState;
	body: string;
	submittedAt: Date | null;
	attached: boolean;
	resolveAttached: boolean;
	onAttach: () => void;
	onResolve: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	if (state === "pending") return null;
	if (state === "commented" && body.trim().length === 0) return null;

	return (
		<article className={FEEDBACK_ROW_CLASS}>
			<GitHubAvatar
				name={author}
				url={authorAvatarUrl}
				className="mt-0.5 size-5"
			/>
			<div className="min-w-0 flex-1">
				<div className="flex h-6 min-w-0 items-center gap-1.5 text-xs">
					<span className="max-w-[45%] shrink-0 truncate font-medium text-foreground">
						{author}
					</span>
					<ReviewStateLabel state={state} />
					{submittedAt !== null ? (
						<span className={cn("min-w-0 truncate", DOCK_META_CLASS)}>
							{formatRelative(submittedAt)}
						</span>
					) : null}
					<FeedbackActions
						url={url}
						attached={attached}
						resolveAttached={resolveAttached}
						attachLabel={uiMessage("projects:pr_pane_add_review_to_chat")}
						resolveLabel={uiMessage("projects:pr_pane_resolve_review_feedback")}
						onAttach={onAttach}
						onResolve={onResolve}
					/>
				</div>
				{body.trim().length > 0 ? <PlainTextPreview text={body} /> : null}
			</div>
		</article>
	);
}

function ReviewStateLabel({ state }: { state: GitPrReviewState }) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);
	const [label, className] =
		state === "approved"
			? [uiMessage("projects:pr_pane_approved"), "text-[var(--accent-green)]"]
			: state === "changes_requested"
				? [
						uiMessage("projects:pr_pane_changes_requested"),
						"text-[var(--accent-red)]",
					]
				: state === "dismissed"
					? [uiMessage("projects:pr_pane_dismissed"), "text-muted-foreground"]
					: [uiMessage("projects:pr_pane_commented"), "text-muted-foreground"];
	return (
		<span className={cn("min-w-0 truncate text-[11px]", className)}>
			{label}
		</span>
	);
}

function FeedbackCommentRow({
	author,
	authorAvatarUrl,
	url,
	path,
	line,
	body,
	createdAt,
	attached,
	resolveAttached,
	onAttach,
	onResolve,
}: {
	author: string;
	authorAvatarUrl: string | null;
	url: string | null;
	path: string | null;
	line: number | null;
	body: string;
	createdAt: Date;
	attached: boolean;
	resolveAttached: boolean;
	onAttach: () => void;
	onResolve: () => void;
}) {
	const openChanges = useUiStore((s) => s.openChanges);
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	return (
		<article className={FEEDBACK_ROW_CLASS}>
			<GitHubAvatar
				name={author}
				url={authorAvatarUrl}
				className="mt-0.5 size-5"
			/>
			<div className="min-w-0 flex-1">
				<div className="flex h-6 min-w-0 items-center gap-1.5 text-xs">
					<span className="max-w-[45%] shrink-0 truncate font-medium text-foreground">
						{author}
					</span>
					<span className={cn("min-w-0 truncate", DOCK_META_CLASS)}>
						{formatRelative(createdAt)}
					</span>
					<FeedbackActions
						url={url}
						attached={attached}
						resolveAttached={resolveAttached}
						attachLabel={uiMessage("projects:pr_pane_add_comment_to_chat")}
						resolveLabel={uiMessage(
							"projects:pr_pane_resolve_comment_feedback",
						)}
						onAttach={onAttach}
						onResolve={onResolve}
					/>
				</div>
				{path ? (
					<button
						type="button"
						onClick={() => openChanges(path, line ?? undefined)}
						className="mb-1 max-w-full truncate font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
					>
						{path}
						{line ? `:${line}` : ""}
					</button>
				) : null}
				<PlainTextPreview text={body} />
			</div>
		</article>
	);
}

function CheckRunRow({ run }: { run: GitPrCheckRun }) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	const kind = checkKind(run);
	const duration = formatCheckDuration(run);
	const detail = [
		run.workflowName ?? null,
		run.runnerGroupName ?? null,
		run.runnerName ?? null,
	]
		.filter((part): part is string => part !== null && part.length > 0)
		.join(" · ");
	const hasDetails = isHttpUrl(run.url);
	return (
		<li className={cn(DOCK_ROW_CLASS, "group gap-0 pr-1")}>
			<button
				type="button"
				disabled={!hasDetails}
				title={detail.length > 0 ? `${run.name} · ${detail}` : run.name}
				aria-label={uiMessage("projects:pr_pane_open_check_details")}
				onClick={() => {
					if (run.url) openExternal(run.url);
				}}
				className="flex h-full min-w-0 flex-1 items-center gap-2 text-left outline-none disabled:cursor-default"
			>
				<CheckStatusIcon run={run} />
				<span className="min-w-0 flex-1 truncate text-foreground/90">
					{run.name}
				</span>
			</button>
			<span
				className={cn(
					"shrink-0 pl-2 tabular-nums",
					DOCK_META_CLASS,
					kind === "failure" && "text-[var(--accent-red)]",
					isHttpUrl(run.runUrl) &&
						"group-hover:hidden group-focus-within:hidden",
				)}
			>
				{kind === "success" && duration !== null ? duration : checkLabel(run)}
			</span>
			{isHttpUrl(run.runUrl) ? (
				<button
					type="button"
					aria-label={uiMessage("projects:pr_pane_open_workflow_run")}
					title={uiMessage("projects:pr_pane_open_workflow_run")}
					onClick={() => {
						if (run.runUrl) openExternal(run.runUrl);
					}}
					className={cn(
						DOCK_ICON_BUTTON_CLASS,
						"hidden size-6 group-hover:inline-flex group-focus-within:inline-flex",
					)}
				>
					<HugeiconsIcon icon={ArrowUpRight01Icon} className="size-3.5" />
				</button>
			) : null}
		</li>
	);
}

function checkLabel(run: GitPrCheckRun): string {
	if (checkKind(run) === "pending") {
		if (run.status === "queued") return "Queued";
		if (run.status === "in_progress") return "Running";
		return "Pending";
	}
	switch (run.conclusion) {
		case "success":
			return "Passed";
		case "failure":
			return "Failed";
		case "cancelled":
			return "Cancelled";
		case "timed_out":
			return "Timed out";
		case "action_required":
			return "Action required";
		case "skipped":
			return "Skipped";
		case "neutral":
			return "Neutral";
		default:
			return "Unknown";
	}
}

function formatCheckDuration(run: GitPrCheckRun): string | null {
	const start = run.startedAt ?? null;
	const end = run.completedAt ?? null;
	if (start === null) return null;
	const endMs = end === null ? Date.now() : end.getTime();
	const seconds = Math.max(0, Math.round((endMs - start.getTime()) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	return `${hours}h`;
}

function AttachButton({
	label,
	onClick,
	attached = false,
	children,
}: {
	label: string;
	onClick: () => void;
	attached?: boolean;
	children?: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			onClick={onClick}
			className={cn(
				"inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] outline-none transition focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring",
				attached
					? "text-[var(--accent-green)] hover:bg-muted/60"
					: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
			)}
		>
			<HugeiconsIcon
				icon={attached ? Tick01Icon : CommentAdd01Icon}
				className="size-3.5"
			/>
			{children}
		</button>
	);
}

function Empty({ children }: { children: ReactNode }) {
	return (
		<p className="px-4 py-6 text-center text-xs text-muted-foreground">
			{children}
		</p>
	);
}
