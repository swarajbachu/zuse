import { Rpc } from "@effect/rpc";
import { Schema } from "effect";

import { FolderId, WorktreeId } from "./ids.ts";

export class GitCommit extends Schema.Class<GitCommit>("GitCommit")({
  sha: Schema.String,
  shortSha: Schema.String,
  subject: Schema.String,
  authorName: Schema.String,
  authoredAt: Schema.DateFromString,
  parents: Schema.Array(Schema.String),
}) {}

export class GitStatusSummary extends Schema.Class<GitStatusSummary>(
  "GitStatusSummary",
)({
  branch: Schema.NullOr(Schema.String),
  ahead: Schema.Number,
  behind: Schema.Number,
  dirtyFiles: Schema.Number,
}) {}

export const GitBranchKind = Schema.Literal("local", "remote");
export type GitBranchKind = typeof GitBranchKind.Type;

export class GitBranchInfo extends Schema.Class<GitBranchInfo>("GitBranchInfo")(
  {
    name: Schema.String,
    current: Schema.Boolean,
    remote: Schema.NullOr(Schema.String),
    upstream: Schema.NullOr(Schema.String),
    kind: GitBranchKind,
  },
) {}

export class GitNotARepoError extends Schema.TaggedError<GitNotARepoError>()(
  "GitNotARepoError",
  { folderId: FolderId },
) {}

export class GitNotInstalledError extends Schema.TaggedError<GitNotInstalledError>()(
  "GitNotInstalledError",
  {},
) {}

export class GitCommandError extends Schema.TaggedError<GitCommandError>()(
  "GitCommandError",
  { folderId: FolderId, reason: Schema.String },
) {}

export class GitFolderNotFoundError extends Schema.TaggedError<GitFolderNotFoundError>()(
  "GitFolderNotFoundError",
  { folderId: FolderId },
) {}

const GitErrors = Schema.Union(
  GitNotARepoError,
  GitNotInstalledError,
  GitCommandError,
  GitFolderNotFoundError,
);

export const GitLogRpc = Rpc.make("git.log", {
  payload: Schema.Struct({ folderId: FolderId, limit: Schema.Number }),
  success: Schema.Array(GitCommit),
  error: GitErrors,
});

export const GitStatusRpc = Rpc.make("git.status", {
  payload: Schema.Struct({
    folderId: FolderId,
    /**
     * When set, run `git status` inside the worktree path so the branch +
     * dirty/ahead counts reflect the worktree, not the main checkout.
     */
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  }),
  success: GitStatusSummary,
  error: GitErrors,
});

export const GitBranchesRpc = Rpc.make("git.branches", {
  payload: Schema.Struct({
    folderId: FolderId,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  }),
  success: Schema.Array(GitBranchInfo),
  error: GitErrors,
});

export const GitSwitchBranchRpc = Rpc.make("git.switchBranch", {
  payload: Schema.Struct({
    folderId: FolderId,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
    branch: Schema.String,
    remote: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  success: GitStatusSummary,
  error: GitErrors,
});

export const GitRenameBranchRpc = Rpc.make("git.renameBranch", {
  payload: Schema.Struct({
    folderId: FolderId,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
    name: Schema.String,
  }),
  success: GitStatusSummary,
  error: GitErrors,
});

/**
 * `git config user.name` for the folder, trimmed. Returns an empty string
 * when unset. Used by the auto-namer to build `username/<slug>` branch names
 * (the name is slugified before use).
 */
export const GitUserNameRpc = Rpc.make("git.userName", {
  payload: Schema.Struct({ folderId: FolderId }),
  success: Schema.Struct({ userName: Schema.String }),
  error: GitErrors,
});

export const GitHeadChangedRpc = Rpc.make("git.headChanged", {
  payload: Schema.Struct({ folderId: FolderId }),
  success: Schema.Struct({ sha: Schema.String }),
  error: GitErrors,
  stream: true,
});

export class GitOriginInfo extends Schema.Class<GitOriginInfo>("GitOriginInfo")(
  {
    host: Schema.String,
    owner: Schema.String,
    repo: Schema.String,
  },
) {}

export const GitOriginRpc = Rpc.make("git.origin", {
  payload: Schema.Struct({ folderId: FolderId }),
  success: Schema.NullOr(GitOriginInfo),
  error: GitErrors,
});

/**
 * State of the GitHub PR (if any) opened from the folder's current HEAD branch
 * against its upstream. `gh pr view --json state,additions,deletions,...` is
 * the source of truth — when `gh` is missing or no PR exists, this returns
 * `{ state: "none" }` and the renderer falls back to a plain timestamp.
 */
export const GitPrState = Schema.Literal("none", "open", "closed", "merged");
export type GitPrState = typeof GitPrState.Type;

/**
 * Aggregated CI rollup status for the PR's HEAD commit.
 *   none    — PR has no required checks, or `gh` couldn't read the rollup.
 *   pending — at least one check still running / queued.
 *   success — all checks passed.
 *   failure — at least one check failed (cancelled / errored counts as fail).
 */
export const GitPrChecks = Schema.Literal(
  "none",
  "pending",
  "success",
  "failure",
);
export type GitPrChecks = typeof GitPrChecks.Type;

/**
 * Merge-conflict state from `gh pr view --json mergeable`.
 *   clean       — GitHub says the PR is mergeable.
 *   conflicting — at least one path in the branch conflicts with the base.
 *   unknown     — GitHub hasn't computed it yet, no PR exists, or `gh` couldn't read it.
 */
export const GitPrMergeable = Schema.Literal("clean", "conflicting", "unknown");
export type GitPrMergeable = typeof GitPrMergeable.Type;

export class GitPrInfo extends Schema.Class<GitPrInfo>("GitPrInfo")({
  state: GitPrState,
  branch: Schema.NullOr(Schema.String),
  baseBranch: Schema.NullOr(Schema.String),
  additions: Schema.Number,
  deletions: Schema.Number,
  number: Schema.NullOr(Schema.Number),
  url: Schema.NullOr(Schema.String),
  isDraft: Schema.Boolean,
  checks: GitPrChecks,
  mergeable: GitPrMergeable,
  /**
   * Per-check counts derived from the same `statusCheckRollup` that feeds
   * `checks`. Lets the top bar render "N checks running" without the heavier
   * `prDetails` round-trip. `checksTotal === 0` means the PR has no checks.
   */
  checksTotal: Schema.Number,
  checksRunning: Schema.Number,
  checksPassing: Schema.Number,
  checksFailing: Schema.Number,
  /**
   * True when GitHub has a pending auto-merge request on this PR (`gh pr view
   * --json autoMergeRequest` is non-null). Reflects the "Auto-merge on success"
   * toggle's real, server-side state.
   */
  autoMergeEnabled: Schema.Boolean,
}) {}

export const GitPrStateRpc = Rpc.make("git.prState", {
  payload: Schema.Struct({
    folderId: FolderId,
    /**
     * When set, runs `gh pr view` inside the worktree's path so the result
     * reflects the worktree's branch — each worktree has its own branch,
     * each branch has its own PR (or none).
     */
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  }),
  success: GitPrInfo,
  error: GitErrors,
});

export class GitPrComment extends Schema.Class<GitPrComment>("GitPrComment")({
  author: Schema.String,
  body: Schema.String,
  createdAt: Schema.DateFromString,
}) {}

export const GitPrReviewState = Schema.Literal(
  "approved",
  "changes_requested",
  "commented",
  "dismissed",
  "pending",
);
export type GitPrReviewState = typeof GitPrReviewState.Type;

export class GitPrReview extends Schema.Class<GitPrReview>("GitPrReview")({
  author: Schema.String,
  state: GitPrReviewState,
  body: Schema.String,
  submittedAt: Schema.NullOr(Schema.DateFromString),
}) {}

export class GitPrFile extends Schema.Class<GitPrFile>("GitPrFile")({
  path: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
}) {}

export const GitPrCheckRunStatus = Schema.Literal(
  "queued",
  "in_progress",
  "completed",
  "pending",
);
export type GitPrCheckRunStatus = typeof GitPrCheckRunStatus.Type;

export const GitPrCheckRunConclusion = Schema.Literal(
  "success",
  "failure",
  "cancelled",
  "skipped",
  "neutral",
  "timed_out",
  "action_required",
);
export type GitPrCheckRunConclusion = typeof GitPrCheckRunConclusion.Type;

export class GitPrCheckRun extends Schema.Class<GitPrCheckRun>("GitPrCheckRun")(
  {
    name: Schema.String,
    status: GitPrCheckRunStatus,
    conclusion: Schema.NullOr(GitPrCheckRunConclusion),
    url: Schema.NullOr(Schema.String),
  },
) {}

/**
 * Heavier per-PR payload than {@link GitPrInfo}: title, body, reviews, comments,
 * files changed, and the per-run check breakdown. Fetched lazily when the PR
 * pane is open — `git.prState` keeps its lightweight contract for the sidebar.
 */
export class GitPrDetails extends Schema.Class<GitPrDetails>("GitPrDetails")({
  state: GitPrState,
  number: Schema.NullOr(Schema.Number),
  url: Schema.NullOr(Schema.String),
  isDraft: Schema.Boolean,
  checks: GitPrChecks,
  mergeable: GitPrMergeable,
  additions: Schema.Number,
  deletions: Schema.Number,
  title: Schema.String,
  body: Schema.String,
  author: Schema.String,
  baseBranch: Schema.NullOr(Schema.String),
  headBranch: Schema.NullOr(Schema.String),
  comments: Schema.Array(GitPrComment),
  reviews: Schema.Array(GitPrReview),
  files: Schema.Array(GitPrFile),
  checkRuns: Schema.Array(GitPrCheckRun),
}) {}

export const GitPrDetailsRpc = Rpc.make("git.prDetails", {
  payload: Schema.Struct({
    folderId: FolderId,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  }),
  success: GitPrDetails,
  error: GitErrors,
});

/**
 * Captured CI failure artifact. The server pulled logs for every failing
 * check via `gh run view --log-failed`, concatenated them with run-name
 * dividers, and wrote them to `.zuse/failing-checks-<ts>.txt` inside the
 * worktree. The renderer attaches `relPath` to the composer so the agent can
 * read it as `@<relPath>`.
 */
export class GitFailingChecksArtifact extends Schema.Class<GitFailingChecksArtifact>(
  "GitFailingChecksArtifact",
)({
  relPath: Schema.String,
  absPath: Schema.String,
  failingCount: Schema.Number,
}) {}

export const GitFixFailingChecksRpc = Rpc.make("git.fixFailingChecks", {
  payload: Schema.Struct({
    folderId: FolderId,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  }),
  success: GitFailingChecksArtifact,
  error: GitErrors,
});

/**
 * One entry from `git status --porcelain=v2`. `staged` means the index has
 * changes (X column ≠ '.'); `kind` is the dominant working-tree state. We
 * collapse renames/copies to a path that matches the working-tree side so the
 * Diff tab can wire a click to "open this file in the editor."
 */
export const GitChangeKind = Schema.Literal(
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "ignored",
  "unmerged",
  "type_changed",
);
export type GitChangeKind = typeof GitChangeKind.Type;

export class GitChange extends Schema.Class<GitChange>("GitChange")({
  path: Schema.String,
  /**
   * Original path for renamed / copied files (the location HEAD knew the
   * file under). `null` for every other kind. Lets the renderer surface
   * "old → new" so a move doesn't silently look like an unrelated edit.
   */
  oldPath: Schema.NullOr(Schema.String),
  staged: Schema.Boolean,
  kind: GitChangeKind,
}) {}

export const GitChangesRpc = Rpc.make("git.changes", {
  payload: Schema.Struct({
    folderId: FolderId,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  }),
  success: Schema.Array(GitChange),
  error: GitErrors,
});

/**
 * Diff modes returned by `git.diff`. `worktree` is the common case
 * (tracked file with edits); `untracked` is a synthetic /dev/null diff
 * for new files; `deleted` means the file is gone from the working
 * tree but still in HEAD; `binary` and `unchanged` carry no patch text.
 */
export const GitDiffMode = Schema.Literal(
  "worktree",
  "untracked",
  "deleted",
  "binary",
  "unchanged",
);
export type GitDiffMode = typeof GitDiffMode.Type;

export class GitDiffResult extends Schema.Class<GitDiffResult>("GitDiffResult")(
  {
    mode: GitDiffMode,
    patch: Schema.String,
    truncated: Schema.Boolean,
    bytes: Schema.Number,
  },
) {}

export const GitDiffRpc = Rpc.make("git.diff", {
  payload: Schema.Struct({
    folderId: FolderId,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
    path: Schema.String,
  }),
  success: GitDiffResult,
  error: GitErrors,
});

export const GitCommitRpc = Rpc.make("git.commit", {
  payload: Schema.Struct({
    folderId: FolderId,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
    message: Schema.String,
    /**
     * Explicit set of paths to commit. When provided (and non-empty), only
     * these paths are staged + committed (`git add -- <paths>` then
     * `git commit -m … -- <paths>`), so the Changes tab can let the user pick
     * which files go into the commit. Omitted/empty falls back to the legacy
     * "commit everything" behaviour (`git add -A`).
     */
    paths: Schema.optional(Schema.Array(Schema.String)),
  }),
  success: Schema.Struct({ sha: Schema.String }),
  error: GitErrors,
});

export const GitPushRpc = Rpc.make("git.push", {
  payload: Schema.Struct({
    folderId: FolderId,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  }),
  success: Schema.Struct({ output: Schema.String }),
  error: GitErrors,
});

/**
 * Merge method passed to `gh pr merge`. Mirrors GitHub's three merge buttons;
 * the renderer remembers the last-used value (default `merge`).
 */
export const GitMergeMethod = Schema.Literal("merge", "squash", "rebase");
export type GitMergeMethod = typeof GitMergeMethod.Type;

/**
 * Direct PR merge via `gh pr merge`. No agent involved.
 *   merge        — merge now: `gh pr merge --<method> [--delete-branch]`
 *   enable-auto  — arm GitHub-native auto-merge so the PR merges once required
 *                  checks pass: `gh pr merge --auto --<method> [--delete-branch]`
 *                  (requires the repo's "Allow auto-merge" setting).
 *   disable-auto — cancel a pending auto-merge: `gh pr merge --disable-auto`.
 * `gh`'s stderr is surfaced verbatim via GitCommandError so the renderer can
 * show e.g. "auto-merge is not allowed for this repository".
 */
export const GitMergePrRpc = Rpc.make("git.mergePr", {
  payload: Schema.Struct({
    folderId: FolderId,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
    action: Schema.Literal("merge", "enable-auto", "disable-auto"),
    method: GitMergeMethod,
    deleteBranch: Schema.Boolean,
  }),
  success: Schema.Struct({ output: Schema.String }),
  error: GitErrors,
});

/**
 * Mark a draft PR ready for review via `gh pr ready`. No agent involved.
 */
export const GitMarkReadyRpc = Rpc.make("git.markReady", {
  payload: Schema.Struct({
    folderId: FolderId,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  }),
  success: Schema.Struct({ output: Schema.String }),
  error: GitErrors,
});

// Initialize a git repository in a project folder that doesn't have one yet.
// Surfaced from the Changes tab's "not a Git repository" empty state. Always
// runs against the folder root (a worktree can't exist without a repo), so no
// `worktreeId` here.
export const GitInitRpc = Rpc.make("git.init", {
  payload: Schema.Struct({
    folderId: FolderId,
  }),
  success: Schema.Struct({ branch: Schema.String }),
  error: GitErrors,
});

/**
 * Discard a single file's uncommitted changes. Behaviour depends on `kind`:
 *   - untracked → delete the new file from disk (`git clean -f`)
 *   - everything else → restore index + working tree to HEAD (`git restore`)
 * Surfaced from the Changes tab's per-row hover "revert" affordance, always
 * behind a confirm dialog. `kind` lets the server pick the right git command
 * without re-running `status`.
 */
export const GitRevertFileRpc = Rpc.make("git.revertFile", {
  payload: Schema.Struct({
    folderId: FolderId,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
    path: Schema.String,
    oldPath: Schema.optional(Schema.NullOr(Schema.String)),
    kind: GitChangeKind,
  }),
  success: Schema.Struct({ reverted: Schema.Boolean }),
  error: GitErrors,
});

/**
 * Discard every uncommitted change in the working tree: `git reset --hard
 * HEAD` followed by `git clean -fd` to also remove untracked files/dirs.
 * Destructive and unrecoverable — the Changes tab gates this behind a strong
 * confirm dialog ("Revert all").
 */
export const GitRevertAllRpc = Rpc.make("git.revertAll", {
  payload: Schema.Struct({
    folderId: FolderId,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  }),
  success: Schema.Struct({ reverted: Schema.Boolean }),
  error: GitErrors,
});

/**
 * Total additions/deletions of a worktree's branch — including uncommitted
 * working-tree edits — relative to its base branch. Computed as
 * `git diff --numstat <merge-base(base, HEAD)>`, where `base` is the repo's
 * default branch (`origin/HEAD`, falling back to origin/main, main, …). Drives
 * the projects sidebar's per-chat `+N −N` stats so a branch shows its diff
 * even before a PR is opened. Returns zeros rather than failing when there's
 * no base, no commits, or no diff.
 */
export const GitDiffStatRpc = Rpc.make("git.diffStat", {
  payload: Schema.Struct({
    folderId: FolderId,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  }),
  success: Schema.Struct({
    additions: Schema.Number,
    deletions: Schema.Number,
  }),
  error: GitErrors,
});
