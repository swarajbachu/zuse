import { HugeiconsIcon } from "@hugeicons/react";
import { CircleIcon, LinkSquare01Icon, Loading02Icon, MinusSignCircleIcon, Tick01Icon } from "@hugeicons-pro/core-bulk-rounded";
import { GitPullRequestIcon } from "@hugeicons-pro/core-solid-rounded";
import { X } from "lucide-react";
import { useEffect } from "react";

import type {
  FolderId,
  GitPrCheckRun,
  GitPrDetails,
  GitPrInfo,
  GitPrReviewState,
  WorktreeId,
} from "@memoize/wire";

import { softTone, type Tone } from "../lib/tones.ts";
import { gitStatusKey, useGitStatusStore } from "../store/git-status.ts";
import { prDetailsKey, usePrDetailsStore } from "../store/pr-details.ts";
import { prStateKey, usePrStateStore } from "../store/pr-state.ts";
import { GitInitCta } from "./git-init-cta.tsx";
import { MarkdownBody } from "./markdown-body.tsx";

const openExternal = (url: string) => {
  const bridge = window.memoize?.app;
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
        <NoPrState branch={status.branch} dirtyFiles={status.dirtyFiles} ahead={status.ahead} />
      ) : (
        <PrBody
          pr={pr!}
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
            <Pill tone="sky">{ahead} commit{ahead === 1 ? "" : "s"}</Pill>
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

  return (
    <>
      <Section>
        <div className="flex items-start gap-2">
          <HugeiconsIcon icon={GitPullRequestIcon} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
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
        <p className="text-muted-foreground">Loading PR details…</p>
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

          {details.reviews.length > 0 ? (
            <Section title={`Reviews (${details.reviews.length})`}>
              <div className="flex flex-col gap-2">
                {details.reviews.map((r, idx) => (
                  <ReviewBlock
                    key={`${r.author}-${idx}`}
                    author={r.author}
                    state={r.state}
                    body={r.body}
                    submittedAt={r.submittedAt}
                  />
                ))}
              </div>
            </Section>
          ) : null}

          {details.comments.length > 0 ? (
            <Section title={`Comments (${details.comments.length})`}>
              <div className="flex flex-col gap-2">
                {details.comments.map((c, idx) => (
                  <CommentBlock
                    key={`${c.author}-${idx}`}
                    author={c.author}
                    body={c.body}
                    createdAt={c.createdAt}
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
                icon={<HugeiconsIcon icon={CircleIcon} className="size-4 text-zinc-400" />}
                title="Draft"
                body="Mark the PR as ready for review to start running checks."
              />
            ) : orderedChecks.length === 0 ? (
              <Indicator
                icon={<HugeiconsIcon icon={CircleIcon} className="size-4 text-muted-foreground" />}
                title="No checks configured"
                body="There aren't any required status checks on this branch."
              />
            ) : (
              <ul className="flex flex-col">
                {orderedChecks.map((c, idx) => (
                  <CheckRunRow key={`${c.name}-${idx}`} run={c} />
                ))}
              </ul>
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
  author,
  state,
  body,
  submittedAt,
}: {
  author: string;
  state: GitPrReviewState;
  body: string;
  submittedAt: Date | null;
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
        {submittedAt !== null ? (
          <span className="text-[10px] text-muted-foreground">
            {formatRelative(submittedAt)}
          </span>
        ) : null}
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
  author,
  body,
  createdAt,
}: {
  author: string;
  body: string;
  createdAt: Date;
}) {
  return (
    <article className="flex flex-col gap-1.5 rounded-sm border border-border/60 bg-foreground/[0.02] px-2 py-1.5">
      <header className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-foreground/90">{author}</span>
        <span className="text-[10px] text-muted-foreground">
          {formatRelative(createdAt)}
        </span>
      </header>
      {body.trim().length > 0 ? (
        <div className="max-h-48 overflow-y-auto">
          <MarkdownBody>{body}</MarkdownBody>
        </div>
      ) : null}
    </article>
  );
}

function CheckRunRow({ run }: { run: GitPrCheckRun }) {
  const icon = checkIcon(run);
  const inner = (
    <div className="flex items-center gap-2">
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/90">
        {run.name}
      </span>
      {run.url !== null ? (
        <HugeiconsIcon icon={LinkSquare01Icon} className="size-3 shrink-0 text-muted-foreground" />
      ) : null}
    </div>
  );
  if (run.url !== null) {
    return (
      <li>
        <button
          type="button"
          onClick={() => openExternal(run.url!)}
          className="-mx-1 flex w-[calc(100%+0.5rem)] items-center rounded-sm px-1 py-0.5 transition-colors hover:bg-foreground/5"
        >
          {inner}
        </button>
      </li>
    );
  }
  return <li className="px-1 py-0.5">{inner}</li>;
}

function checkIcon(run: GitPrCheckRun) {
  if (run.status !== "completed") {
    if (run.status === "queued" || run.status === "pending") {
      return <HugeiconsIcon icon={CircleIcon} className="size-4 text-muted-foreground" />;
    }
    return <HugeiconsIcon icon={Loading02Icon} className="size-4 animate-spin text-amber-300" />;
  }
  switch (run.conclusion) {
    case "success":
      return <HugeiconsIcon icon={Tick01Icon} className="size-3 text-emerald-400" />;
    case "failure":
    case "cancelled":
    case "timed_out":
    case "action_required":
      return <X className="size-3 text-rose-300" strokeWidth={1.8} />;
    case "skipped":
    case "neutral":
      return <HugeiconsIcon icon={MinusSignCircleIcon} className="size-3.5 text-muted-foreground" />;
    default:
      return <HugeiconsIcon icon={CircleIcon} className="size-3.5 text-muted-foreground" />;
  }
}

function Section({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      {title !== undefined ? (
        <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
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

function Pill({
  tone,
  children,
}: {
  tone: Tone;
  children: React.ReactNode;
}) {
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
