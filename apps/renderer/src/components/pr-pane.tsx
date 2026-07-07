import { HugeiconsIcon } from "@hugeicons/react";
import {
  CircleIcon,
  LinkSquare01Icon,
  Loading02Icon,
  MinusSignCircleIcon,
  Tick01Icon,
} from "@hugeicons-pro/core-bulk-rounded";
import { GitPullRequestIcon } from "@hugeicons-pro/core-solid-rounded";
import { Plus, X } from "lucide-react";
import { useEffect } from "react";

import type {
  FolderId,
  GitPrComment,
  GitPrCheckRun,
  GitPrDetails,
  GitPrInfo,
  GitPrReview,
  GitPrReviewState,
  WorktreeId,
} from "@zuse/wire";

import {
  attachFileWhenReady,
  saveContextFile,
} from "../lib/context-handoff.ts";
import { softTone, type Tone } from "../lib/tones.ts";
import { useComposerBridge } from "../store/composer-bridge.ts";
import { gitStatusKey, useGitStatusStore } from "../store/git-status.ts";
import { prDetailsKey, usePrDetailsStore } from "../store/pr-details.ts";
import { prStateKey, usePrStateStore } from "../store/pr-state.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { GitInitCta } from "./git-init-cta.tsx";
import { MarkdownBody } from "./markdown-body.tsx";
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

const markdownForReviews = (
  pr: PrMarkdownContext,
  reviews: ReadonlyArray<GitPrReview>,
): string =>
  `${prMarkdownHeader(pr)}
${reviews
  .map(
    (review, idx) => `## Review ${idx + 1}
- Author: ${review.author}
- State: ${reviewStateLabel(review.state)}
- Submitted: ${formatAbsolute(review.submittedAt)}

${review.body.trim().length > 0 ? review.body.trim() : "(no review body)"}`,
  )
  .join("\n\n")}
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

const markdownForComments = (
  pr: PrMarkdownContext,
  comments: ReadonlyArray<GitPrComment>,
): string =>
  `${prMarkdownHeader(pr)}
${comments
  .map(
    (comment, idx) => `## Comment ${idx + 1}
- Author: ${comment.author}
- Created: ${formatAbsolute(comment.createdAt)}

${comment.body.trim().length > 0 ? comment.body.trim() : "(no comment body)"}`,
  )
  .join("\n\n")}
`;

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

  const hasPr = pr !== null && pr.state !== "none";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3 text-xs">
      {!hasPr ? (
        <NoPrState
          branch={status.branch}
          dirtyFiles={status.dirtyFiles}
          ahead={status.ahead}
        />
      ) : (
        <PrBody pr={pr!} details={details} detailsLoading={detailsLoading} />
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
  const attachMarkdown = async (markdown: string, label: string) => {
    if (selectedSessionId === null) {
      toastManager.add({
        type: "error",
        title: "No active chat",
        description: "Open a chat before attaching PR feedback.",
      });
      return;
    }
    const ref = await saveContextFile(selectedSessionId, markdown);
    if (ref === null) {
      toastManager.add({
        type: "error",
        title: "Couldn't attach feedback",
        description: "The PR feedback file could not be created.",
      });
      return;
    }
    setActiveMainTab("chat");
    attachFileWhenReady(ref);
    setTimeout(() => useComposerBridge.getState().focus?.(), 75);
    toastManager.add({
      type: "success",
      title: `${label} attached`,
      description: `Added ${ref.relPath} to the composer.`,
    });
  };
  const prContext = {
    number,
    title,
    url,
  };
  const visibleReviews = details?.reviews.filter(isVisibleReview) ?? [];

  return (
    <>
      <Section>
        <div className="flex items-start gap-2">
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
              <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {title.length > 0 ? title : "(no title)"}
              </h2>
            </div>
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
          </div>
        </div>
        {url !== null ? (
          <button
            type="button"
            onClick={() => openExternal(url)}
            className="-mx-1 mt-1 flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <HugeiconsIcon icon={LinkSquare01Icon} className="size-3" />
            Open in browser
          </button>
        ) : null}
      </Section>

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
            <Section title="Description">
              <ScrollBox>
                <MarkdownBody>{body}</MarkdownBody>
              </ScrollBox>
            </Section>
          ) : null}

          {visibleReviews.length > 0 ? (
            <Section
              title={`Reviews (${visibleReviews.length})`}
              action={
                <AttachButton
                  label="Add all reviews to chat"
                  onClick={() =>
                    void attachMarkdown(
                      markdownForReviews(prContext, visibleReviews),
                      "Reviews",
                    )
                  }
                >
                  Add all
                </AttachButton>
              }
            >
              <div className="flex flex-col gap-2">
                {visibleReviews.map((r, idx) => (
                  <ReviewBlock
                    key={`${r.author}-${idx}`}
                    pr={prContext}
                    author={r.author}
                    state={r.state}
                    body={r.body}
                    submittedAt={r.submittedAt}
                    onAttach={(markdown) =>
                      void attachMarkdown(markdown, "Review")
                    }
                  />
                ))}
              </div>
            </Section>
          ) : null}

          {details.comments.length > 0 ? (
            <Section
              title={`Comments (${details.comments.length})`}
              action={
                <AttachButton
                  label="Add all comments to chat"
                  onClick={() =>
                    void attachMarkdown(
                      markdownForComments(prContext, details.comments),
                      "Comments",
                    )
                  }
                >
                  Add all
                </AttachButton>
              }
            >
              <div className="flex flex-col gap-2">
                {details.comments.map((c, idx) => (
                  <CommentBlock
                    key={`${c.author}-${idx}`}
                    pr={prContext}
                    author={c.author}
                    body={c.body}
                    createdAt={c.createdAt}
                    onAttach={(markdown) =>
                      void attachMarkdown(markdown, "Comment")
                    }
                  />
                ))}
              </div>
            </Section>
          ) : null}

          <Section
            title={
              orderedChecks.length > 0
                ? `Checks (${orderedChecks.length})`
                : "Checks"
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
    </>
  );
}

/**
 * Bounded scroller for long PR bodies / comments. The fz-prose surface inside
 * can render arbitrarily long markdown — without a cap a single comment with
 * code listings dominates the panel and pushes everything below off-screen.
 */
function ScrollBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-h-64 overflow-y-auto rounded-sm border border-border/60 bg-foreground/[0.02] px-2 py-1.5">
      {children}
    </div>
  );
}

function ReviewBlock({
  pr,
  author,
  state,
  body,
  submittedAt,
  onAttach,
}: {
  pr: PrMarkdownContext;
  author: string;
  state: GitPrReviewState;
  body: string;
  submittedAt: Date | null;
  onAttach: (markdown: string) => void;
}) {
  if (state === "pending") return null;
  if (state === "commented" && body.trim().length === 0) return null;

  return (
    <article className="flex flex-col gap-1.5 rounded-sm border border-border/60 bg-foreground/[0.02] px-2 py-1.5">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <ReviewStatePill state={state} />
          <span className="text-[11px] text-foreground/90">{author}</span>
        </div>
        <div className="flex items-center gap-2">
          {submittedAt !== null ? (
            <span className="text-[10px] text-muted-foreground">
              {formatRelative(submittedAt)}
            </span>
          ) : null}
          <AttachButton
            label="Add review to chat"
            onClick={() =>
              onAttach(
                markdownForReview(pr, { author, state, body, submittedAt }),
              )
            }
          />
        </div>
      </header>
      {body.trim().length > 0 ? (
        <div className="max-h-48 overflow-y-auto">
          <MarkdownBody>{body}</MarkdownBody>
        </div>
      ) : null}
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

function CommentBlock({
  pr,
  author,
  body,
  createdAt,
  onAttach,
}: {
  pr: PrMarkdownContext;
  author: string;
  body: string;
  createdAt: Date;
  onAttach: (markdown: string) => void;
}) {
  return (
    <article className="flex flex-col gap-1.5 rounded-sm border border-border/60 bg-foreground/[0.02] px-2 py-1.5">
      <header className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-foreground/90">{author}</span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">
            {formatRelative(createdAt)}
          </span>
          <AttachButton
            label="Add comment to chat"
            onClick={() =>
              onAttach(markdownForComment(pr, { author, body, createdAt }))
            }
          />
        </div>
      </header>
      {body.trim().length > 0 ? (
        <div className="max-h-48 overflow-y-auto">
          <MarkdownBody>{body}</MarkdownBody>
        </div>
      ) : null}
    </article>
  );
}

type CheckTone = "emerald" | "amber" | "red" | "zinc" | "sky";

function ChecksPanel({ checks }: { checks: ReadonlyArray<GitPrCheckRun> }) {
  const groups = groupChecks(checks);
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
    <div className="flex flex-col gap-2">
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
      <div className="overflow-hidden rounded-sm border border-border/60">
        {groups.map((group, groupIdx) => (
          <div
            key={group.key}
            className={groupIdx === 0 ? "" : "border-t border-border/60"}
          >
            {group.label !== null ? (
              <div className="flex min-h-7 items-center justify-between gap-2 bg-foreground/[0.025] px-2 py-1">
                <div className="min-w-0">
                  <div className="truncate text-[11px] font-medium text-foreground/90">
                    {group.label}
                  </div>
                  {group.runnerLabel !== null ? (
                    <div className="truncate text-[10px] text-muted-foreground">
                      {group.runnerLabel}
                    </div>
                  ) : null}
                </div>
                {group.runUrl !== null ? (
                  <IconLinkButton
                    label="Open workflow run"
                    onClick={() => openExternal(group.runUrl!)}
                  >
                    Run
                  </IconLinkButton>
                ) : null}
              </div>
            ) : null}
            <ul className="flex flex-col divide-y divide-border/40">
              {group.checks.map((run, idx) => (
                <CheckRunRow key={`${run.name}-${idx}`} run={run} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function CheckRunRow({ run }: { run: GitPrCheckRun }) {
  const kind = checkKind(run);
  const duration = formatCheckDuration(run);
  const runner = [run.runnerGroupName ?? null, run.runnerName ?? null]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" / ");
  return (
    <li className="flex min-h-9 items-center gap-2 px-2 py-1.5">
      <span className="shrink-0">{checkIcon(run)}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-[11px] text-foreground/90">
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
      <div className="flex shrink-0 items-center gap-1">
        {run.runUrl !== null && run.runUrl !== undefined ? (
          <IconLinkButton
            label="Open workflow run"
            onClick={() => openExternal(run.runUrl!)}
          >
            Run
          </IconLinkButton>
        ) : null}
        {run.url !== null ? (
          <IconLinkButton
            label="Open check details"
            onClick={() => openExternal(run.url!)}
          >
            Job
          </IconLinkButton>
        ) : null}
      </div>
    </li>
  );
}

type CheckGroup = {
  readonly key: string;
  readonly label: string | null;
  readonly runnerLabel: string | null;
  readonly runUrl: string | null;
  readonly checks: ReadonlyArray<GitPrCheckRun>;
};

function groupChecks(
  checks: ReadonlyArray<GitPrCheckRun>,
): ReadonlyArray<CheckGroup> {
  const map = new Map<string, GitPrCheckRun[]>();
  for (const check of checks) {
    const key =
      check.runId !== null && check.runId !== undefined
        ? `run:${check.runId}`
        : check.workflowName !== null && check.workflowName !== undefined
          ? `workflow:${check.workflowName}`
          : "external";
    const group = map.get(key);
    if (group === undefined) map.set(key, [check]);
    else group.push(check);
  }
  return [...map.entries()].map(([key, group]) => {
    const first = group[0]!;
    const label =
      first.workflowName ??
      (first.runId != null ? `Workflow run ${first.runId}` : null);
    const runnerNames = new Set(
      group
        .map((run) => run.runnerName ?? null)
        .filter((name): name is string => name !== null && name.length > 0),
    );
    const runnerGroups = new Set(
      group
        .map((run) => run.runnerGroupName ?? null)
        .filter((name): name is string => name !== null && name.length > 0),
    );
    const runnerParts = [
      runnerGroups.size === 1 ? [...runnerGroups][0] : null,
      runnerNames.size === 1 ? [...runnerNames][0] : null,
    ].filter((part): part is string => part !== null);
    return {
      key,
      label,
      runnerLabel: runnerParts.length > 0 ? runnerParts.join(" / ") : null,
      runUrl: first.runUrl ?? null,
      checks: group,
    };
  });
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
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex h-5 items-center gap-1 rounded-sm px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
    >
      <HugeiconsIcon icon={LinkSquare01Icon} className="size-3" />
      {children}
    </button>
  );
}

function AttachButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
    >
      <Plus className="size-3" strokeWidth={1.8} />
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
  children,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      {title !== undefined ? (
        <div className="flex min-h-5 items-center justify-between gap-2">
          <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {title}
          </h3>
          {action}
        </div>
      ) : null}
      <div className="flex flex-col gap-1">{children}</div>
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
