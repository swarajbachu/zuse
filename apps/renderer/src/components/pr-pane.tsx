import { HugeiconsIcon } from "@hugeicons/react";
import {
	CircleIcon,
	GitPullRequestIcon,
	Loading02Icon,
	MinusSignCircleIcon,
	Tick01Icon,
} from "@hugeicons-pro/core-solid-rounded";
import type {
	FolderId,
	GitPrCheckRun,
	GitPrComment,
	GitPrDetails,
	GitPrReview,
	GitPrReviewState,
	WorktreeId,
} from "@zuse/contracts";
import { GitPrInfo } from "@zuse/contracts";
import { ArrowUpRight, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
	attachFileWhenReady,
	saveContextFile,
} from "../lib/context-handoff.ts";
import { softTone, type Tone } from "../lib/tones.ts";
import { useComposerBridge } from "../store/composer-bridge.ts";
import {
	composerDraftKeyForSession,
	useComposerDraftsStore,
} from "../store/composer-drafts.ts";
import { gitStatusKey, useGitStatusStore } from "../store/git-status.ts";
import { prDetailsKey, usePrDetailsStore } from "../store/pr-details.ts";
import { prStateKey, usePrStateStore } from "../store/pr-state.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { GitInitCta } from "./git-init-cta.tsx";
import { ClaudeIcon } from "./icons/claude-icon.tsx";
import {
	Frame,
	FrameFooter,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from "./ui/frame.tsx";
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
	return date.toLocaleDateString();
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
	comment: Pick<GitPrComment, "author" | "body" | "createdAt">,
): string =>
	`${prMarkdownHeader(pr)}
## Comment
- Author: ${comment.author}
- Created: ${formatAbsolute(comment.createdAt)}

${comment.body.trim().length > 0 ? comment.body.trim() : "(no comment body)"}
`;

const markdownToPlainText = (value: string): string =>
	value
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!\[[^\]]*]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^[-*+]\s+/gm, "")
		.replace(/^\s*>\s?/gm, "")
		.replace(/[*_~#]/g, "")
		.replace(/\s+/g, " ")
		.trim();

/**
 * Right-pane "PR" tab. Title, state, description, reviews, comments, and CI
 * checks for the branch's open PR. Files-changed lives in the Changes tab.
 * Worktree-aware — each worktree has its own branch and PR, so all
 * lookups + the lazy details fetch are keyed by `(folderId, worktreeId)`.
 */
export function PrPane({
	folderId,
	worktreeId,
}: {
	folderId: FolderId | null;
	worktreeId: WorktreeId | null;
}) {
	const status = useGitStatusStore((s) =>
		folderId ? (s.byKey[gitStatusKey(folderId, worktreeId)] ?? null) : null,
	);
	const noRepo = useGitStatusStore((s) =>
		folderId
			? s.noRepoByKey[gitStatusKey(folderId, worktreeId)] === true
			: false,
	);
	const pr = usePrStateStore((s) =>
		folderId ? (s.byKey[prStateKey(folderId, worktreeId)] ?? null) : null,
	);
	const details = usePrDetailsStore((s) =>
		folderId ? (s.byKey[prDetailsKey(folderId, worktreeId)] ?? null) : null,
	);
	const detailsLoading = usePrDetailsStore((s) =>
		folderId
			? s.loadingByKey[prDetailsKey(folderId, worktreeId)] === true
			: false,
	);
	const hydrateDetails = usePrDetailsStore((s) => s.hydrate);

	useEffect(() => {
		if (folderId !== null) void hydrateDetails(folderId, worktreeId);
	}, [folderId, worktreeId, hydrateDetails]);

	if (folderId === null) {
		return <Empty>Select a project to see its PR here.</Empty>;
	}
	if (noRepo) {
		return (
			<div className="flex min-h-0 flex-1 flex-col px-3 py-3 text-xs">
				<GitInitCta folderId={folderId} worktreeId={worktreeId} />
			</div>
		);
	}
	if (status === null) {
		return <Empty>Reading branch state…</Empty>;
	}

	const detailsPr =
		details !== null && details.state !== "none"
			? prInfoFromDetails(details)
			: null;
	const effectivePr = pr !== null && pr.state !== "none" ? pr : detailsPr;

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3 text-xs">
			{effectivePr === null ? (
				<NoPrState
					branch={status.branch}
					dirtyFiles={status.dirtyFiles}
					ahead={status.ahead}
				/>
			) : (
				<PrBody
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
	return (
		<>
			<Section title="Branch">
				<Row label="Name">
					<span className="font-mono text-[11px] text-foreground">
						{branch ?? "(detached)"}
					</span>
				</Row>
				<Row label="Local changes">
					{dirtyFiles > 0 ? (
						<Pill tone="amber">
							{dirtyFiles} file{dirtyFiles === 1 ? "" : "s"}
						</Pill>
					) : (
						<span className="text-muted-foreground">clean</span>
					)}
				</Row>
				<Row label="Ahead of upstream">
					{ahead > 0 ? (
						<Pill tone="sky">
							{ahead} commit{ahead === 1 ? "" : "s"}
						</Pill>
					) : (
						<span className="text-muted-foreground">in sync</span>
					)}
				</Row>
			</Section>
			<p className="text-muted-foreground">
				No pull request open for this branch.
			</p>
		</>
	);
}

function PrBody({
	pr,
	details,
	detailsLoading,
}: {
	pr: GitPrInfo;
	details: GitPrDetails | null;
	detailsLoading: boolean;
}) {
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
			: (s.draftsByKey[composerDraftKeyForSession(selectedSessionId)] ?? null),
	);
	const composerFilePaths = useMemo(() => {
		const paths = new Set<string>();
		for (const chip of composerDraft?.chips ?? []) {
			if (chip.meta.kind === "file") paths.add(chip.meta.relPath);
		}
		return paths;
	}, [composerDraft]);
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
				title: "No active chat",
				description: "Open a chat before attaching PR feedback.",
			});
			return null;
		}
		const ref = await saveContextFile(selectedSessionId, markdown);
		if (ref === null) {
			toastManager.add({
				type: "error",
				title: "Couldn't attach feedback",
				description: "The PR feedback file could not be created.",
			});
			return null;
		}
		setActiveMainTab("chat");
		attachFileWhenReady(ref);
		setTimeout(() => useComposerBridge.getState().focus?.(), 75);
		if (options.toast !== false) {
			toastManager.add({
				type: "success",
				title: `${label} attached`,
				description: `Added ${ref.relPath} to the composer.`,
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
		let count = 0;
		for (const [idx, review] of visibleReviews.entries()) {
			const key = reviewKey(review, idx);
			if (feedbackAttached(key)) continue;
			const attached = await attachFeedbackItem(
				key,
				markdownForReview(prContext, review),
				"Review",
				{ toast: false },
			);
			if (attached) count += 1;
		}
		for (const [idx, comment] of comments.entries()) {
			const key = commentKey(comment, idx);
			if (feedbackAttached(key)) continue;
			const attached = await attachFeedbackItem(
				key,
				markdownForComment(prContext, comment),
				"Comment",
				{ toast: false },
			);
			if (attached) count += 1;
		}
		if (count > 0) {
			toastManager.add({
				type: "success",
				title: "Feedback attached",
				description: `Added ${count} file${count === 1 ? "" : "s"} to the composer.`,
			});
		}
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
		<div className="flex flex-col gap-3">
			<Frame>
				<FrameHeader className="flex-row items-start justify-between gap-3 px-3 py-2">
					<div className="flex min-w-0 items-start gap-2.5">
						<HugeiconsIcon
							icon={GitPullRequestIcon}
							className="mt-0.5 size-4 shrink-0 text-muted-foreground"
						/>
						<div className="flex min-w-0 flex-1 flex-col gap-1">
							<div className="flex items-baseline gap-2">
								{number !== null ? (
									<span className="font-mono text-[11px] text-muted-foreground">
										#{number}
									</span>
								) : null}
								<FrameTitle className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
									{title.length > 0 ? title : "(no title)"}
								</FrameTitle>
							</div>
						</div>
					</div>
				</FrameHeader>
				<FramePanel className="px-3 py-2">
					<div className="flex flex-wrap items-center gap-1.5">
						<PrStatePill pr={pr} />
						{headBranch !== null && baseBranch !== null ? (
							<span className="font-mono text-[10px] text-muted-foreground">
								{headBranch} → {baseBranch}
							</span>
						) : null}
						<span className="font-mono text-[10px]">
							<span className="text-emerald-300/90">+{additions}</span>{" "}
							<span className="text-rose-300/90">−{deletions}</span>
						</span>
					</div>
				</FramePanel>
				{url !== null ? (
					<FrameFooter className="px-3 py-2">
						<button
							type="button"
							onClick={() => openExternal(url)}
							className="-mx-1 flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
						>
							<ArrowUpRight className="size-3" strokeWidth={1.8} />
							Open in browser
						</button>
					</FrameFooter>
				) : null}
			</Frame>

			{detailsLoading && details === null ? (
				<ShimmerText as="p" className="text-muted-foreground">
					Loading PR details…
				</ShimmerText>
			) : details === null ? (
				<p className="text-amber-300/80">
					<code className="font-mono">gh</code> couldn't read PR details.
				</p>
			) : (
				<>
					{body.trim().length > 0 ? (
						<Section title="Description" panelClassName="p-3">
							<PlainTextPreview text={body} />
						</Section>
					) : null}

					{feedbackCount > 0 ? (
						<Section
							title={`Feedback (${feedbackCount})`}
							action={
								<AttachButton
									label="Add all feedback to chat"
									onClick={() => void attachAllFeedback()}
									attached={allFeedbackAttached}
								>
									Add all
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
								? `Checks (${orderedChecks.length})`
								: "Checks"
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
								title="Draft"
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
								title="No checks configured"
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
	const preview = markdownToPlainText(text);
	if (preview.length === 0) return null;
	return (
		<p className="overflow-hidden text-[11px] leading-5 text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:4]">
			{preview}
		</p>
	);
}

function FeedbackReviewRow({
	author,
	authorAvatarUrl,
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
	state: GitPrReviewState;
	body: string;
	submittedAt: Date | null;
	attached: boolean;
	resolveAttached: boolean;
	onAttach: () => void;
	onResolve: () => void;
}) {
	if (state === "pending") return null;
	if (state === "commented" && body.trim().length === 0) return null;

	return (
		<article className="group flex min-w-0 items-start gap-2 border-b border-border/45 px-3 py-2 transition-colors last:border-b-0 hover:bg-muted/35">
			<ReviewerAvatar name={author} avatarUrl={authorAvatarUrl} />
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-1.5">
					<span className="shrink-0 text-[11px] font-medium text-foreground/90">
						{author}
					</span>
					<ReviewStatePill state={state} />
					{submittedAt !== null ? (
						<span className="shrink-0 text-[10px] text-muted-foreground">
							{formatRelative(submittedAt)}
						</span>
					) : null}
				</div>
				{body.trim().length > 0 ? (
					<p className="mt-0.5 overflow-hidden text-[11px] leading-5 text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
						{markdownToPlainText(body)}
					</p>
				) : null}
			</div>
			<div className="flex shrink-0 items-center gap-1">
				<AttachButton
					label="Resolve review feedback"
					attached={resolveAttached}
					hideUntilHover
					onClick={onResolve}
				>
					Resolve
				</AttachButton>
				<AttachButton
					label="Add review to chat"
					attached={attached}
					hideUntilHover
					onClick={onAttach}
				>
					{attached ? "Added" : "Add to chat"}
				</AttachButton>
			</div>
		</article>
	);
}

function ReviewStatePill({ state }: { state: GitPrReviewState }) {
	if (state === "approved") return <Pill tone="emerald">Approved</Pill>;
	if (state === "changes_requested")
		return <Pill tone="red">Changes requested</Pill>;
	if (state === "dismissed") return <Pill tone="zinc">Dismissed</Pill>;
	return <Pill tone="sky">Commented</Pill>;
}

function FeedbackCommentRow({
	author,
	authorAvatarUrl,
	body,
	createdAt,
	attached,
	resolveAttached,
	onAttach,
	onResolve,
}: {
	author: string;
	authorAvatarUrl: string | null;
	body: string;
	createdAt: Date;
	attached: boolean;
	resolveAttached: boolean;
	onAttach: () => void;
	onResolve: () => void;
}) {
	return (
		<article className="group flex min-w-0 items-center gap-2 border-b border-border/45 px-3 py-2 transition-colors last:border-b-0 hover:bg-muted/35">
			<ReviewerAvatar name={author} avatarUrl={authorAvatarUrl} />
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-baseline gap-2">
					<span className="shrink-0 text-[11px] font-medium text-foreground/90">
						{author}
					</span>
					<span className="shrink-0 text-[10px] text-muted-foreground">
						{formatRelative(createdAt)}
					</span>
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-1">
				<AttachButton
					label="Resolve comment feedback"
					attached={resolveAttached}
					hideUntilHover
					onClick={onResolve}
				>
					Resolve
				</AttachButton>
				<AttachButton
					label="Add comment to chat"
					attached={attached}
					hideUntilHover
					onClick={onAttach}
				>
					{attached ? "Added" : "Add to chat"}
				</AttachButton>
			</div>
		</article>
	);
}

type CheckTone = "emerald" | "amber" | "red" | "zinc" | "sky";

function ServiceMark({
	name,
	className = "size-5",
}: {
	name: string;
	className?: string;
}) {
	const lower = name.toLowerCase();
	const githubLogo = githubServiceLogo(name);
	if (githubLogo !== null) {
		return (
			<img
				src={githubLogo.url}
				alt=""
				title={githubLogo.title}
				className={`${className} shrink-0 rounded-full bg-muted object-cover`}
			/>
		);
	}
	if (lower.includes("claude")) {
		return (
			<span
				className={`${className} flex shrink-0 items-center justify-center rounded-full bg-orange-500/15 text-orange-400`}
				title="Claude"
			>
				<ClaudeIcon className="size-3" />
			</span>
		);
	}
	const label = lower.includes("macroscope")
		? "M"
		: lower.includes("coderabbit") || lower.includes("code rabbit")
			? "CR"
			: name.trim().slice(0, 2).toUpperCase() || "?";
	return (
		<span
			className={`${className} flex shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground`}
			title={name}
		>
			{label}
		</span>
	);
}

function githubServiceLogo(
	name: string,
): { readonly title: string; readonly url: string } | null {
	const lower = name.toLowerCase();
	const account = lower.includes("vercel")
		? "vercel"
		: lower.includes("cloudflare")
			? "cloudflare"
			: lower.includes("gitguardian")
				? "GitGuardian"
				: lower.includes("github")
					? "github"
					: lower.includes("coderabbit") || lower.includes("code rabbit")
						? "coderabbitai"
						: lower.includes("macroscope")
							? "macroscope"
							: null;
	if (account === null) return null;
	return {
		title: account,
		url: `https://github.com/${account}.png?size=40`,
	};
}

function ReviewerAvatar({
	name,
	avatarUrl,
}: {
	name: string;
	avatarUrl: string | null;
}) {
	if (avatarUrl !== null && avatarUrl.length > 0) {
		return (
			<img
				src={avatarUrl}
				alt=""
				className="size-5 shrink-0 rounded-full bg-muted object-cover"
			/>
		);
	}
	return <ServiceMark name={name} className="size-5" />;
}

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
			<ServiceMark name={run.name} className="size-5" />
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-1.5">
					<span className="min-w-0 truncate text-[12px] text-foreground/90">
						{run.name}
					</span>
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
						label="Open workflow run"
						onClick={() => openExternal(run.runUrl!)}
					/>
				) : null}
				{run.url !== null ? (
					<IconLinkButton
						label="Open check details"
						onClick={() => openExternal(run.url!)}
					/>
				) : null}
			</div>
		</li>
	);
}

function checkKind(
	run: GitPrCheckRun,
): "success" | "pending" | "failure" | "neutral" {
	if (run.status !== "completed") return "pending";
	switch (run.conclusion) {
		case "success":
			return "success";
		case "failure":
		case "cancelled":
		case "timed_out":
		case "action_required":
			return "failure";
		default:
			return "neutral";
	}
}

function CheckSummary({ checks }: { checks: ReadonlyArray<GitPrCheckRun> }) {
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
			<StatusPill tone="zinc">{counts.total} total</StatusPill>
			{counts.failure > 0 ? (
				<StatusPill tone="red">{counts.failure} failing</StatusPill>
			) : null}
			{counts.pending > 0 ? (
				<StatusPill tone="amber">{counts.pending} running</StatusPill>
			) : null}
			{counts.success > 0 ? (
				<StatusPill tone="emerald">{counts.success} passed</StatusPill>
			) : null}
			{counts.neutral > 0 ? (
				<StatusPill tone="zinc">{counts.neutral} skipped</StatusPill>
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
			className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-[10px] font-medium transition focus-visible:opacity-100 ${
				hideUntilHover && !attached
					? "opacity-0 group-hover:opacity-100"
					: "opacity-100"
			} ${
				attached
					? "border-emerald-400/35 bg-emerald-400/10 text-emerald-300 hover:border-emerald-300/50 hover:bg-emerald-400/15 hover:text-emerald-200"
					: "border-border/70 bg-muted/45 text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground"
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
	panelClassName = "p-3",
	children,
}: {
	title?: string;
	action?: React.ReactNode;
	footer?: React.ReactNode;
	panelClassName?: string;
	children: React.ReactNode;
}) {
	return (
		<Frame>
			{title !== undefined ? (
				<FrameHeader className="flex-row items-center justify-between gap-2 px-3 py-2">
					<FrameTitle className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
						{title}
					</FrameTitle>
					{action}
				</FrameHeader>
			) : null}
			<FramePanel className={panelClassName}>{children}</FramePanel>
			{footer !== undefined && footer !== null ? (
				<FrameFooter className="px-3 py-2">{footer}</FrameFooter>
			) : null}
		</Frame>
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
			className={`flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-[10px] ${softTone(tone)}`}
		>
			{children}
		</span>
	);
}

function PrStatePill({ pr }: { pr: GitPrInfo }) {
	if (pr.isDraft) return <Pill tone="zinc">Draft</Pill>;
	if (pr.state === "merged") return <Pill tone="violet">Merged</Pill>;
	if (pr.state === "closed") return <Pill tone="rose">Closed</Pill>;
	if (pr.mergeable === "conflicting")
		return <Pill tone="red">Open · conflicts</Pill>;
	if (pr.checks === "failure")
		return <Pill tone="red">Open · checks failed</Pill>;
	if (pr.checks === "pending")
		return <Pill tone="amber">Open · checks running</Pill>;
	return <Pill tone="emerald">Open</Pill>;
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
