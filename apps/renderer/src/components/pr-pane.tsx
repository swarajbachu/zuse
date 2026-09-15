import { formatDate as formatUiDate } from "@zuse/i18n";
import { checkKind } from "../lib/pr-checks.ts";
import { GitHubAvatar } from "./github-avatar.tsx";
import { MarkdownBody } from "./markdown-body.tsx";
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
	CircleIcon,
	Loading02Icon,
	MinusSignCircleIcon,
	Tick01Icon,
} from "@zuse/icons/solid-rounded";
import { ArrowUpRight, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";

import {
	attachFileWhenReady,
	saveContextFile,
} from "../lib/context-handoff.ts";
import {
	refreshGitPrDetails,
	useGitPrDetailsResource,
	useGitWorkspaceResource,
} from "../lib/git-workspace-client-bus.ts";
import { prRepairMarkdown } from "../lib/pr-repair.ts";
import { softTone, type Tone } from "../lib/tones.ts";
import { useComposerBridge } from "../store/composer-bridge.ts";
import {
	composerDraftKeyForSession,
	useComposerDraftsStore,
} from "../store/composer-drafts.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { GitInitCta } from "./git-init-cta.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";
import { toastManager } from "./ui/toast.tsx";

const openExternal = (url: string) => {
	const bridge = window.zuse?.app;
	if (bridge !== undefined) {
		bridge.openExternal(url);
		return;
	}
	window.open(url, "_blank", "noopener,noreferrer");
};

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

const checkCountsFromRuns = (runs: ReadonlyArray<GitPrCheckRun>) =>
	runs.reduce(
		(acc, run) => {
			acc.total += 1;
			const kind = checkKind(run);
			if (kind === "success") acc.passing += 1;
			else if (kind === "pending") acc.running += 1;
			else if (kind === "failure") acc.failing += 1;
			return acc;
		},
		{ total: 0, passing: 0, running: 0, failing: 0 },
	);

const prInfoFromDetails = (details: GitPrDetails): GitPrInfo => {
	const counts = checkCountsFromRuns(details.checkRuns);
	return GitPrInfo.make({
		state: details.state,
		branch: details.headBranch,
		baseBranch: details.baseBranch,
		additions: details.additions,
		deletions: details.deletions,
		number: details.number,
		url: details.url,
		isDraft: details.isDraft,
		checks: details.checks,
		mergeable: details.mergeable,
		checksTotal: counts.total,
		checksRunning: counts.running,
		checksPassing: counts.passing,
		checksFailing: counts.failing,
		autoMergeEnabled: false,
	});
};

const markdownForReview = (
	pr: PrMarkdownContext,
	review: Pick<GitPrReview, "author" | "state" | "body" | "submittedAt">,
): string =>
	`${prMarkdownHeader(pr)}
## Review
- Author: ${review.author}
- State: ${reviewStateLabel(review.state)}
- Submitted: ${formatAbsolute(review.submittedAt)}

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

	const workspaceView = useGitWorkspaceResource(executionRef, "connect");
	const detailsView = useGitPrDetailsResource(executionRef, "connect");
	const status = workspaceView.data?.status ?? null;
	const noRepo = workspaceView.data?.noRepository === true;
	const pr = workspaceView.data?.pr ?? null;
	const rawDetails = detailsView.data?.details ?? null;
	const details = rawDetails?.headBranch === status?.branch ? rawDetails : null;
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
			<div className="flex min-h-0 flex-1 flex-col px-3 py-3 text-xs">
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

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3 text-xs">
			{detailsView.data?.error && (
				<div
					role="status"
					className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2 text-muted-foreground"
				>
					<span>
						Couldn’t refresh this PR. {detailsView.data.error.message}
					</span>
					<button
						type="button"
						className="h-7 shrink-0 px-2 text-foreground"
						disabled={detailsLoading}
						onClick={() => void refreshGitPrDetails(executionRef)}
					>
						Retry
					</button>
				</div>
			)}
			{effectivePr === null ? (
				<NoPrState
					branch={status.branch}
					dirtyFiles={status.dirtyFiles}
					ahead={status.ahead}
				/>
			) : (
				<PrOverview
					executionRef={executionRef}
					pr={effectivePr}
					details={details}
					detailsLoading={detailsLoading}
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
		<>
			<Section title={uiMessage("projects:pr_pane_branch")}>
				<Row label={uiMessage("projects:pr_pane_name")}>
					<span className="font-mono text-xs text-foreground">
						{branch ?? uiMessage("projects:pr_pane_detached")}
					</span>
				</Row>
				<Row label={uiMessage("projects:pr_pane_local_changes")}>
					{dirtyFiles > 0 ? (
						<Pill tone="amber">
							{uiMessage("projects:pr_pane_file_plural0_sentence", {
								dirtyFiles: dirtyFiles ?? "",
								count: dirtyFiles,
							})}
						</Pill>
					) : (
						<span className="text-muted-foreground">
							{uiMessage("projects:pr_pane_clean")}
						</span>
					)}
				</Row>
				<Row label={uiMessage("projects:pr_pane_ahead_of_upstream")}>
					{ahead > 0 ? (
						<Pill tone="sky">
							{uiMessage("projects:pr_pane_commit_plural0_sentence", {
								ahead: ahead ?? "",
								count: ahead,
							})}
						</Pill>
					) : (
						<span className="text-muted-foreground">
							{uiMessage("projects:pr_pane_in_sync")}
						</span>
					)}
				</Row>
			</Section>
			<p className="text-muted-foreground">
				{uiMessage("projects:pr_pane_no_pull_request_open_for_this_branch")}
			</p>
		</>
	);
}

export function PrOverview({
	executionRef,
	pr,
	details,
	detailsLoading,
}: {
	executionRef: ExecutionRef;
	pr: GitPrInfo;
	details: GitPrDetails | null;
	detailsLoading: boolean;
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

	// Sort failing checks first when the rollup says failure — that's what the
	// user opened the tab to investigate.
	const checkRuns = details?.checkRuns ?? [];
	const orderedChecks =
		pr.checks === "failure"
			? [...checkRuns].sort(
					(a, b) =>
						(a.conclusion === "failure" ? 0 : 1) -
						(b.conclusion === "failure" ? 0 : 1),
				)
			: checkRuns;
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

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-2 sm:p-4">
			<header className="space-y-5">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0 space-y-2">
						<h1 className="break-words text-xl font-semibold leading-snug text-foreground">
							{title || `Pull request #${number}`}
						</h1>
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<GitHubAvatar
								name={details?.author ?? ""}
								url={details?.authorAvatarUrl}
							/>
							<span>{details?.author}</span>
							<span>#{number}</span>
						</div>
					</div>
					{url ? (
						<IconLinkButton
							label="Open pull request in GitHub"
							onClick={() => openExternal(url)}
						/>
					) : null}
				</div>
				<dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-6 gap-y-3 text-xs">
					<dt className="text-muted-foreground">Branch</dt>
					<dd className="flex flex-wrap items-center gap-2">
						<span className="break-all">
							{headBranch} → {baseBranch}
						</span>
						<span className="text-[var(--accent-green)]">+{additions}</span>
						<span className="text-[var(--accent-red)]">−{deletions}</span>
					</dd>
					<dt className="text-muted-foreground">Status</dt>
					<dd>
						<PrStatePill pr={pr} />
					</dd>
					<dt className="text-muted-foreground">Comments</dt>
					<dd>{feedbackCount}</dd>
					<dt className="text-muted-foreground">Checks</dt>
					<dd>
						<CheckSummary checks={checkRuns} />
					</dd>
				</dl>
			</header>

			{detailsLoading && details === null ? (
				<ShimmerText as="p" className="text-muted-foreground">
					{uiMessage("projects:pr_pane_loading_pr_details")}
				</ShimmerText>
			) : details === null ? (
				<p className="text-amber-300/80">
					<RichMessage
						id="projects:pr_pane_gh_couldn_t_read_pr_details_sentence"
						components={{ part0: <code className="font-mono" /> }}
						values={{ code0: "gh" }}
					/>
				</p>
			) : (
				<>
					{body.trim().length > 0 ? (
						<Section
							title={uiMessage("projects:pr_pane_description")}
							panelClassName="py-1"
						>
							<PlainTextPreview text={body} />
						</Section>
					) : null}

					{feedbackCount > 0 ? (
						<Section
							title={uiMessage("projects:pr_pane_feedback", {
								feedbackCount: String(feedbackCount),
							})}
							action={
								<AttachButton
									label={uiMessage("projects:pr_pane_add_all_feedback_to_chat")}
									onClick={() => void attachAllFeedback()}
									attached={allFeedbackAttached}
								>
									{uiMessage("projects:pr_pane_add_all")}
								</AttachButton>
							}
							panelClassName="p-0"
						>
							<div className="overflow-hidden">
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
						</Section>
					) : null}

					<Section
						title={
							orderedChecks.length > 0
								? uiMessage("projects:pr_pane_checks_2", {
										value1: String(orderedChecks.length),
									})
								: uiMessage("projects:pr_pane_checks")
						}
						panelClassName={
							orderedChecks.length > 0 && !pr.isDraft ? "p-0" : "p-3"
						}
						footer={
							orderedChecks.length > 0 ? (
								<CheckSummary checks={orderedChecks} />
							) : null
						}
					>
						{pr.isDraft ? (
							<Indicator
								icon={
									<HugeiconsIcon
										icon={CircleIcon}
										className="size-4 text-zinc-400"
									/>
								}
								title={uiMessage("projects:pr_pane_draft")}
								body="Mark the PR as ready for review to start running checks."
							/>
						) : orderedChecks.length === 0 ? (
							<Indicator
								icon={
									<HugeiconsIcon
										icon={CircleIcon}
										className="size-4 text-muted-foreground"
									/>
								}
								title={uiMessage("projects:pr_pane_no_checks_configured")}
								body="There aren't any required status checks on this branch."
							/>
						) : (
							<ChecksPanel checks={orderedChecks} />
						)}
					</Section>
				</>
			)}
		</div>
	);
}

function PlainTextPreview({ text }: { text: string }) {
	return (
		<MarkdownBody githubHtml className="text-xs leading-5">
			{text}
		</MarkdownBody>
	);
}

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
		<article className="group flex min-w-0 flex-wrap items-start gap-2 border-b border-border/45 px-3 py-2 transition-colors last:border-b-0 hover:bg-muted/35">
			<GitHubAvatar name={author} url={authorAvatarUrl} />
			<div className="min-w-0 flex-1 basis-48">
				<div className="flex min-w-0 items-center gap-1.5">
					<span className="shrink-0 text-xs font-medium text-foreground/90">
						{author}
					</span>
					<ReviewStatePill state={state} />
					{submittedAt !== null ? (
						<span className="shrink-0 text-[10px] text-muted-foreground">
							{formatRelative(submittedAt)}
						</span>
					) : null}
				</div>
				{body.trim().length > 0 ? <PlainTextPreview text={body} /> : null}
			</div>
			<div className="flex shrink-0 items-center gap-1">
				{url ? (
					<IconLinkButton
						label="Open in GitHub"
						onClick={() => openExternal(url)}
					/>
				) : null}
				<AttachButton
					label={uiMessage("projects:pr_pane_resolve_review_feedback")}
					attached={resolveAttached}
					hideUntilHover
					onClick={onResolve}
				>
					{uiMessage("projects:pr_pane_resolve")}
				</AttachButton>
				<AttachButton
					label={uiMessage("projects:pr_pane_add_review_to_chat")}
					attached={attached}
					hideUntilHover
					onClick={onAttach}
				>
					{attached
						? uiMessage("projects:pr_pane_added")
						: uiMessage("projects:pr_pane_add_to_chat")}
				</AttachButton>
			</div>
		</article>
	);
}

function ReviewStatePill({ state }: { state: GitPrReviewState }) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	if (state === "approved")
		return <Pill tone="emerald">{uiMessage("projects:pr_pane_approved")}</Pill>;
	if (state === "changes_requested")
		return (
			<Pill tone="red">{uiMessage("projects:pr_pane_changes_requested")}</Pill>
		);
	if (state === "dismissed")
		return <Pill tone="zinc">{uiMessage("projects:pr_pane_dismissed")}</Pill>;
	return <Pill tone="sky">{uiMessage("projects:pr_pane_commented")}</Pill>;
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
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	return (
		<article className="group flex min-w-0 flex-wrap items-start gap-2 border-b border-border/45 px-3 py-2 transition-colors last:border-b-0 hover:bg-muted/35">
			<GitHubAvatar name={author} url={authorAvatarUrl} />
			<div className="min-w-0 flex-1 basis-48">
				<div className="flex min-w-0 items-baseline gap-2">
					<span className="shrink-0 text-xs font-medium text-foreground/90">
						{author}
					</span>
					<span className="shrink-0 text-[10px] text-muted-foreground">
						{formatRelative(createdAt)}
					</span>
				</div>
				{path ? (
					<div className="my-1 font-mono text-xs text-muted-foreground">
						{path}
						{line ? `:${line}` : ""}
					</div>
				) : null}
				<PlainTextPreview text={body} />
			</div>
			<div className="flex shrink-0 items-center gap-1">
				{url ? (
					<IconLinkButton
						label="Open in GitHub"
						onClick={() => openExternal(url)}
					/>
				) : null}
				<AttachButton
					label={uiMessage("projects:pr_pane_resolve_comment_feedback")}
					attached={resolveAttached}
					hideUntilHover
					onClick={onResolve}
				>
					{uiMessage("projects:pr_pane_resolve")}
				</AttachButton>
				<AttachButton
					label={uiMessage("projects:pr_pane_add_comment_to_chat")}
					attached={attached}
					hideUntilHover
					onClick={onAttach}
				>
					{attached
						? uiMessage("projects:pr_pane_added")
						: uiMessage("projects:pr_pane_add_to_chat")}
				</AttachButton>
			</div>
		</article>
	);
}

type CheckTone = "emerald" | "amber" | "red" | "zinc" | "sky";

function ChecksPanel({ checks }: { checks: ReadonlyArray<GitPrCheckRun> }) {
	return (
		<ul className="flex flex-col divide-y divide-border/45">
			{checks.map((run, idx) => (
				<CheckRunRow key={`${run.name}-${idx}`} run={run} />
			))}
		</ul>
	);
}

function CheckRunRow({ run }: { run: GitPrCheckRun }) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	const kind = checkKind(run);
	const duration = formatCheckDuration(run);
	const runner = [run.runnerGroupName ?? null, run.runnerName ?? null]
		.filter((part): part is string => part !== null && part.length > 0)
		.join(" / ");
	return (
		<li className="group flex min-h-10 items-center gap-2 px-3 py-2 transition-colors hover:bg-muted/35">
			<span className="grid size-5 shrink-0 place-items-center">
				{checkIcon(run)}
			</span>
			{run.appAvatarUrl ? (
				<GitHubAvatar name={run.appName ?? run.name} url={run.appAvatarUrl} />
			) : null}
			<div className="min-w-0 flex-1 basis-48">
				<div className="flex min-w-0 items-center gap-1.5">
					<button
						type="button"
						disabled={!run.url}
						onClick={() => {
							if (run.url) openExternal(run.url);
						}}
						className="min-w-0 flex-1 truncate text-left text-xs text-foreground/90 hover:underline disabled:no-underline"
					>
						{run.name}
					</button>
					<StatusPill tone={checkTone(kind)}>{checkLabel(run)}</StatusPill>
				</div>
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
					{run.workflowName !== null && run.workflowName !== undefined ? (
						<span className="truncate">{run.workflowName}</span>
					) : null}
					{runner.length > 0 ? (
						<span className="truncate">{runner}</span>
					) : null}
					{duration !== null ? <span>{duration}</span> : null}
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
				{run.runUrl !== null && run.runUrl !== undefined ? (
					<IconLinkButton
						label={uiMessage("projects:pr_pane_open_workflow_run")}
						onClick={() => {
							if (run.runUrl) openExternal(run.runUrl);
						}}
					/>
				) : null}
				{run.url !== null ? (
					<IconLinkButton
						label={uiMessage("projects:pr_pane_open_check_details")}
						onClick={() => {
							if (run.url) openExternal(run.url);
						}}
					/>
				) : null}
			</div>
		</li>
	);
}

function CheckSummary({ checks }: { checks: ReadonlyArray<GitPrCheckRun> }) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	const counts = checks.reduce(
		(acc, run) => {
			const kind = checkKind(run);
			acc.total += 1;
			if (kind === "success") acc.success += 1;
			else if (kind === "pending") acc.pending += 1;
			else if (kind === "failure") acc.failure += 1;
			else acc.neutral += 1;
			return acc;
		},
		{ total: 0, success: 0, pending: 0, failure: 0, neutral: 0 },
	);
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<StatusPill tone="zinc">
				{uiMessage("projects:pr_pane_total_sentence", { value: counts.total })}
			</StatusPill>
			{counts.failure > 0 ? (
				<StatusPill tone="red">
					{uiMessage("projects:pr_pane_failing_sentence", {
						value: counts.failure,
					})}
				</StatusPill>
			) : null}
			{counts.pending > 0 ? (
				<StatusPill tone="amber">
					{uiMessage("projects:pr_pane_running_sentence", {
						value: counts.pending,
					})}
				</StatusPill>
			) : null}
			{counts.success > 0 ? (
				<StatusPill tone="emerald">
					{uiMessage("projects:pr_pane_passed_sentence", {
						value: counts.success,
					})}
				</StatusPill>
			) : null}
			{counts.neutral > 0 ? (
				<StatusPill tone="zinc">
					{uiMessage("projects:pr_pane_skipped_sentence", {
						value: counts.neutral,
					})}
				</StatusPill>
			) : null}
		</div>
	);
}

function checkLabel(run: GitPrCheckRun): string {
	if (run.status === "queued") return "Queued";
	if (run.status === "in_progress") return "Running";
	if (run.status === "pending") return "Pending";
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

function checkTone(kind: ReturnType<typeof checkKind>): CheckTone {
	if (kind === "success") return "emerald";
	if (kind === "pending") return "amber";
	if (kind === "failure") return "red";
	return "zinc";
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

function StatusPill({
	tone,
	children,
}: {
	tone: CheckTone;
	children: React.ReactNode;
}) {
	return (
		<span
			className={`inline-flex h-4 shrink-0 items-center rounded-sm px-1 font-mono text-[9px] leading-none ${softTone(tone)}`}
		>
			{children}
		</span>
	);
}

function IconLinkButton({
	label,
	onClick,
}: {
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			onClick={onClick}
			className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
		>
			<ArrowUpRight className="size-3.5" strokeWidth={1.8} />
		</button>
	);
}

function AttachButton({
	label,
	onClick,
	attached = false,
	hideUntilHover = false,
	children,
}: {
	label: string;
	onClick: () => void;
	attached?: boolean;
	hideUntilHover?: boolean;
	children?: React.ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			onClick={onClick}
			className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[10px] font-medium transition focus-visible:opacity-100 ${
				hideUntilHover && !attached
					? "opacity-0 group-hover:opacity-100"
					: "opacity-100"
			} ${
				attached
					? "border-emerald-400/35 bg-emerald-400/10 text-emerald-300 hover:border-emerald-300/50 hover:bg-emerald-400/15 hover:text-emerald-200"
					: "bg-muted/45 text-muted-foreground hover:bg-muted hover:text-foreground"
			}`}
		>
			{attached ? (
				<HugeiconsIcon icon={Tick01Icon} className="size-3" />
			) : (
				<Plus className="size-3" strokeWidth={1.8} />
			)}
			{children}
		</button>
	);
}

function checkIcon(run: GitPrCheckRun) {
	if (run.status !== "completed") {
		if (run.status === "queued" || run.status === "pending") {
			return (
				<HugeiconsIcon
					icon={CircleIcon}
					className="size-4 text-muted-foreground"
				/>
			);
		}
		return (
			<HugeiconsIcon
				icon={Loading02Icon}
				className="size-4 animate-spin text-amber-300"
			/>
		);
	}
	switch (run.conclusion) {
		case "success":
			return (
				<HugeiconsIcon icon={Tick01Icon} className="size-3 text-emerald-400" />
			);
		case "failure":
		case "cancelled":
		case "timed_out":
		case "action_required":
			return <X className="size-3 text-rose-300" strokeWidth={1.8} />;
		case "skipped":
		case "neutral":
			return (
				<HugeiconsIcon
					icon={MinusSignCircleIcon}
					className="size-3.5 text-muted-foreground"
				/>
			);
		default:
			return (
				<HugeiconsIcon
					icon={CircleIcon}
					className="size-3.5 text-muted-foreground"
				/>
			);
	}
}

function Section({
	title,
	action,
	footer,
	panelClassName = "py-1",
	children,
}: {
	title?: string;
	action?: React.ReactNode;
	footer?: React.ReactNode;
	panelClassName?: string;
	children: React.ReactNode;
}) {
	return (
		<section className="min-w-0">
			{title !== undefined ? (
				<div className="mb-3 flex items-center justify-between gap-2 border-b border-border/50 pb-2">
					<h2 className="text-sm font-medium text-foreground">{title}</h2>
					{action}
				</div>
			) : null}
			<div className={panelClassName}>{children}</div>
			{footer ? <div className="mt-2 flex justify-end">{footer}</div> : null}
		</section>
	);
}

function Row({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-2">
			<span className="text-muted-foreground">{label}</span>
			<span className="flex items-center gap-1.5">{children}</span>
		</div>
	);
}

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
	return (
		<span
			className={`inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-[10px] ${softTone(tone)}`}
		>
			{children}
		</span>
	);
}

function PrStatePill({ pr }: { pr: GitPrInfo }) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	if (pr.isDraft)
		return <Pill tone="zinc">{uiMessage("projects:pr_pane_draft")}</Pill>;
	if (pr.state === "merged")
		return <Pill tone="violet">{uiMessage("projects:pr_pane_merged")}</Pill>;
	if (pr.state === "closed")
		return <Pill tone="rose">{uiMessage("projects:pr_pane_closed")}</Pill>;
	if (pr.mergeable === "conflicting")
		return (
			<Pill tone="red">{uiMessage("projects:pr_pane_open_conflicts")}</Pill>
		);
	if (pr.checks === "failure")
		return (
			<Pill tone="red">{uiMessage("projects:pr_pane_open_checks_failed")}</Pill>
		);
	if (pr.checks === "pending")
		return (
			<Pill tone="amber">
				{uiMessage("projects:pr_pane_open_checks_running")}
			</Pill>
		);
	return <Pill tone="emerald">{uiMessage("common:open")}</Pill>;
}

function Indicator({
	icon,
	title,
	body,
}: {
	icon: React.ReactNode;
	title: string;
	body: string;
}) {
	return (
		<div className="flex items-start gap-2">
			<span className="mt-0.5 shrink-0">{icon}</span>
			<div className="flex flex-col gap-0.5">
				<span className="font-medium text-foreground">{title}</span>
				<span className="text-muted-foreground">{body}</span>
			</div>
		</div>
	);
}

function Empty({ children }: { children: React.ReactNode }) {
	return (
		<p className="px-3 py-6 text-center text-xs text-muted-foreground">
			{children}
		</p>
	);
}
