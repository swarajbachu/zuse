import type {
	FolderId,
	GitBranchInfo,
	GitChange,
	GitChangeKind,
	GitCommandError,
	GitCommit,
	GitDiffResult,
	GitFailingChecksArtifact,
	GitFolderNotFoundError,
	GitIssueSummary,
	GitMergeMethod,
	GitNotARepoError,
	GitNotInstalledError,
	GitOriginInfo,
	GitPrDetails,
	GitPrInfo,
	GitPrSummary,
	GitReviewFileContents,
	GitReviewPatch,
	GitReviewSummary,
	GitStatusSummary,
	WorktreeId,
} from "@zuse/contracts";
import { Context, type Effect, type Stream } from "effect";

type GitFailure =
	| GitNotARepoError
	| GitNotInstalledError
	| GitCommandError
	| GitFolderNotFoundError;

export interface GitServiceShape {
	readonly log: (
		folderId: FolderId,
		limit: number,
	) => Effect.Effect<ReadonlyArray<GitCommit>, GitFailure>;
	readonly status: (
		folderId: FolderId,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<GitStatusSummary, GitFailure>;
	readonly branches: (
		folderId: FolderId,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<ReadonlyArray<GitBranchInfo>, GitFailure>;
	readonly switchBranch: (
		folderId: FolderId,
		branch: string,
		remote?: string | null,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<GitStatusSummary, GitFailure>;
	readonly renameBranch: (
		folderId: FolderId,
		name: string,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<GitStatusSummary, GitFailure>;
	/**
	 * `git config user.name`, trimmed (empty string when unset). Feeds the
	 * auto-namer's `username/<slug>` branch convention.
	 */
	readonly getUserName: (
		folderId: FolderId,
	) => Effect.Effect<string, GitFailure>;
	readonly subscribeHeadChanges: (
		folderId: FolderId,
	) => Stream.Stream<{ readonly sha: string }, GitFailure>;
	readonly origin: (
		folderId: FolderId,
	) => Effect.Effect<GitOriginInfo | null, GitFailure>;
	readonly prState: (
		folderId: FolderId,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<GitPrInfo, GitFailure>;
	readonly prDetails: (
		folderId: FolderId,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<GitPrDetails, GitFailure>;
	/**
	 * Open PRs via `gh pr list`, most-recently-updated first. Degrades to `[]`
	 * when `gh` is missing / unauthenticated / there's no GitHub remote.
	 */
	readonly listPrs: (
		folderId: FolderId,
	) => Effect.Effect<ReadonlyArray<GitPrSummary>, GitFailure>;
	/** Open issues via `gh issue list`. Same graceful degradation as listPrs. */
	readonly listIssues: (
		folderId: FolderId,
	) => Effect.Effect<ReadonlyArray<GitIssueSummary>, GitFailure>;
	/** Render a single issue as Markdown for attachment to a new chat. */
	readonly issueMarkdown: (
		folderId: FolderId,
		number: number,
	) => Effect.Effect<
		{
			readonly number: number;
			readonly title: string;
			readonly url: string;
			readonly markdown: string;
		},
		GitFailure
	>;
	readonly changes: (
		folderId: FolderId,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<ReadonlyArray<GitChange>, GitFailure>;
	readonly diff: (
		folderId: FolderId,
		path: string,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<GitDiffResult, GitFailure>;
	readonly reviewSummary: (
		folderId: FolderId,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<GitReviewSummary, GitFailure>;
	readonly reviewPatches: (
		folderId: FolderId,
		worktreeId?: WorktreeId | null,
	) => Stream.Stream<GitReviewPatch, GitFailure>;
	readonly reviewFileContents: (
		folderId: FolderId,
		path: string,
		oldPath?: string | null,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<GitReviewFileContents, GitFailure>;
	readonly commit: (
		folderId: FolderId,
		message: string,
		worktreeId?: WorktreeId | null,
		paths?: ReadonlyArray<string>,
	) => Effect.Effect<{ readonly sha: string }, GitFailure>;
	readonly push: (
		folderId: FolderId,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<{ readonly output: string }, GitFailure>;
	readonly resolveConflict: (
		folderId: FolderId,
		path: string,
		contents: string,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<Record<string, never>, GitFailure>;
	readonly mergePr: (
		folderId: FolderId,
		action: "merge" | "enable-auto" | "disable-auto",
		method: GitMergeMethod,
		deleteBranch: boolean,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<{ readonly output: string }, GitFailure>;
	readonly markReady: (
		folderId: FolderId,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<{ readonly output: string }, GitFailure>;
	readonly init: (
		folderId: FolderId,
	) => Effect.Effect<{ readonly branch: string }, GitFailure>;
	readonly revertFile: (
		folderId: FolderId,
		path: string,
		kind: GitChangeKind,
		oldPath?: string | null,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<{ readonly reverted: boolean }, GitFailure>;
	readonly revertAll: (
		folderId: FolderId,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<{ readonly reverted: boolean }, GitFailure>;
	readonly restoreFileToBase: (
		folderId: FolderId,
		path: string,
		oldPath?: string | null,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<{ readonly restored: boolean }, GitFailure>;
	readonly diffStat: (
		folderId: FolderId,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<
		{ readonly additions: number; readonly deletions: number },
		GitFailure
	>;
	readonly fixFailingChecks: (
		folderId: FolderId,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<GitFailingChecksArtifact, GitFailure>;
}

export class GitService extends Context.Service<GitService, GitServiceShape>()(
	"memoize/GitService",
) {}
