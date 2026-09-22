import {
	GitCommandError,
	GitPrInfo,
	GitWorkspaceSnapshot,
	MemoizeRpcs,
} from "@zuse/contracts";
import { GitService } from "@zuse/git/git-service";
import { WorktreeNameAllocator } from "@zuse/git/worktree-ports";
import { KeyedEffectSerialWorker } from "@zuse/utils/keyed-worker";
import { Effect, Layer, Semaphore, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
	GitCheckoutProjectionState,
	gitCheckoutIdentity,
} from "./checkout-projection-state.ts";

const Log = MemoizeRpcs.toLayerHandler("git.log", ({ folderId, limit }) =>
	Effect.flatMap(GitService, (svc) => svc.log(folderId, limit)),
);

const Status = MemoizeRpcs.toLayerHandler(
	"git.status",
	({ folderId, worktreeId }) =>
		Effect.flatMap(GitService, (svc) =>
			svc.status(folderId, worktreeId ?? null),
		),
);

const Branches = MemoizeRpcs.toLayerHandler(
	"git.branches",
	({ folderId, worktreeId }) =>
		Effect.flatMap(GitService, (svc) =>
			svc.branches(folderId, worktreeId ?? null),
		),
);

const Stack = MemoizeRpcs.toLayerHandler(
	"git.stack",
	({ folderId, worktreeId, action, name }) =>
		Effect.flatMap(GitService, (svc) =>
			svc.stack(folderId, action, name, worktreeId ?? null),
		),
);

const SwitchBranch = MemoizeRpcs.toLayerHandler(
	"git.switchBranch",
	({ folderId, worktreeId, branch, remote, createFrom }) =>
		Effect.flatMap(GitService, (svc) =>
			svc.switchBranch(
				folderId,
				branch,
				remote ?? null,
				worktreeId ?? null,
				createFrom,
			),
		),
);

const continueBranchWorker = new KeyedEffectSerialWorker<string>();

/** Allocate and create continuation branches atomically per repository. */
const ContinueBranch = MemoizeRpcs.toLayerHandler(
	"git.continueBranch",
	({ folderId, worktreeId }) =>
		continueBranchWorker.run(
			String(folderId),
			Effect.gen(function* () {
				const git = yield* GitService;
				const allocator = yield* WorktreeNameAllocator;
				const branches = yield* git.branches(folderId, worktreeId ?? null);
				const unavailableNames = new Set(
					branches.flatMap((branch) =>
						branch.remote === null
							? [branch.name]
							: [branch.name, branch.remote],
					),
				);
				const allocation = yield* allocator.allocate({
					unavailableNames,
					usedPokemonNumbers: new Set(),
				});
				if (allocation === null)
					return yield* Effect.fail(
						new GitCommandError({
							folderId,
							reason: "Could not allocate a Pokémon branch name.",
						}),
					);
				return yield* git.switchBranch(
					folderId,
					allocation.name,
					null,
					worktreeId ?? null,
					"origin/main",
				);
			}),
		),
);

const UserName = MemoizeRpcs.toLayerHandler("git.userName", ({ folderId }) =>
	Effect.flatMap(GitService, (svc) =>
		svc.getUserName(folderId).pipe(Effect.map((userName) => ({ userName }))),
	),
);

const WorkspaceChanges = MemoizeRpcs.toLayerHandler(
	"git.workspaceChanges",
	({ folderId, worktreeId }) =>
		Stream.unwrap(
			Effect.map(GitService, (svc) =>
				svc.workspaceChanges(folderId, worktreeId ?? null),
			),
		),
);

const snapshotWorker = new KeyedEffectSerialWorker<string>();
const checkoutProjectionState = new GitCheckoutProjectionState<GitPrInfo>();
const localGitPermits = Semaphore.makeUnsafe(4);
const githubPermits = Semaphore.makeUnsafe(2);
const emptyPrSnapshot = (branch: string | null): GitPrInfo =>
	GitPrInfo.make({
		nodeId: null,
		state: "none",
		branch,
		baseBranch: null,
		additions: 0,
		deletions: 0,
		number: null,
		url: null,
		isDraft: false,
		checks: "none",
		mergeable: "unknown",
		checksTotal: 0,
		checksRunning: 0,
		checksPassing: 0,
		checksFailing: 0,
		autoMergeEnabled: false,
		prCapability: "available",
		stale: false,
	});
const prPollDelay = (pr: GitPrInfo): number => {
	const base =
		pr.checks === "pending"
			? 5_000
			: pr.state === "none"
				? 10_000
				: pr.state === "open"
					? 7_000
					: 60_000;
	return Math.round(base * (0.9 + Math.random() * 0.2));
};
const refreshPrSnapshot = (
	svc: GitService["Service"],
	folderId: Parameters<GitService["Service"]["prState"]>[0],
	worktreeId: Parameters<GitService["Service"]["prState"]>[1],
): Effect.Effect<void> =>
	Effect.suspend(() => {
		const refresh = checkoutProjectionState.beginPrRefresh(
			gitCheckoutIdentity(folderId, worktreeId),
		);
		return githubPermits
			.withPermits(1)(svc.prState(folderId, worktreeId))
			.pipe(
				Effect.tap((observed) =>
					Effect.sync(() => {
						checkoutProjectionState.commitPrRefresh(refresh, {
							value: observed,
							nextPollAt: Date.now() + prPollDelay(observed),
						});
					}),
				),
				Effect.catch(() => Effect.void),
			);
	});
const WorkspaceSnapshot = MemoizeRpcs.toLayerHandler(
	"git.workspaceSnapshot",
	({ folderId, worktreeId }) => {
		const selectedWorktree = worktreeId ?? null;
		const identity = gitCheckoutIdentity(folderId, selectedWorktree);
		return snapshotWorker.run(
			identity,
			Effect.gen(function* () {
				const svc = yield* GitService;
				const now = Date.now();
				const local = yield* localGitPermits.withPermits(1)(
					svc.workspaceSnapshot(folderId, selectedWorktree),
				);
				const {
					status,
					changes,
					reviewSummary: summary,
					localFingerprint,
				} = local;
				const cachedPr = checkoutProjectionState.getPrSnapshot(identity);
				const pr = cachedPr?.value ?? emptyPrSnapshot(status.branch);
				const shouldPollPr =
					cachedPr === undefined || cachedPr.nextPollAt <= now;
				if (shouldPollPr) {
					// Claim the next polling slot before forking so concurrent local
					// snapshots cannot launch duplicate `gh` processes. GitHub is never
					// on the local-status critical path; the next reconciliation observes
					// the completed cached value.
					checkoutProjectionState.setPrSnapshot(identity, {
						value: pr,
						nextPollAt: now + 10_000,
					});
					const refresh = checkoutProjectionState.beginPrRefresh(identity);
					yield* Effect.sync(() => {
						Effect.runFork(
							githubPermits
								.withPermits(1)(svc.prState(folderId, selectedWorktree))
								.pipe(
									Effect.tap((observed) =>
										Effect.sync(() => {
											checkoutProjectionState.commitPrRefresh(refresh, {
												value: observed,
												nextPollAt: Date.now() + prPollDelay(observed),
											});
										}),
									),
									Effect.catchCause(() => Effect.void),
								),
						);
					});
				}
				const projectionVersion =
					checkoutProjectionState.nextProjectionVersion(identity);
				return GitWorkspaceSnapshot.make({
					status,
					changes,
					reviewSummary: summary,
					localFingerprint,
					pr,
					diffStat: {
						additions: summary.additions,
						deletions: summary.deletions,
					},
					projectionVersion,
					observedAt: new Date(),
				});
			}),
		);
	},
);

const Origin = MemoizeRpcs.toLayerHandler("git.origin", ({ folderId }) =>
	Effect.flatMap(GitService, (svc) => svc.origin(folderId)),
);

const PrState = MemoizeRpcs.toLayerHandler(
	"git.prState",
	({ folderId, worktreeId }) =>
		Effect.flatMap(GitService, (svc) =>
			svc.prState(folderId, worktreeId ?? null),
		),
);

const PrNotificationClaim = MemoizeRpcs.toLayerHandler(
	"git.prNotification.claim",
	({ identity }) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql<{ readonly identity: string }>`
				INSERT INTO git_pr_notification_claims (identity, claimed_at)
				VALUES (${identity}, ${new Date().toISOString()})
				ON CONFLICT(identity) DO NOTHING
				RETURNING identity
			`.pipe(Effect.orDie);
			return { claimed: rows.length === 1 };
		}),
);

const PrDetails = MemoizeRpcs.toLayerHandler(
	"git.prDetails",
	({ folderId, worktreeId }) =>
		Effect.flatMap(GitService, (svc) =>
			svc.prDetails(folderId, worktreeId ?? null),
		),
);

const CreateReviewComment = MemoizeRpcs.toLayerHandler(
	"git.createReviewComment",
	({ folderId, worktreeId, path, line, side, body }) =>
		Effect.flatMap(GitService, (svc) =>
			svc.createReviewComment(
				folderId,
				path,
				line,
				side,
				body,
				worktreeId ?? null,
			),
		),
);

const ReviewIdentity = MemoizeRpcs.toLayerHandler(
	"git.reviewIdentity",
	({ folderId, worktreeId }) =>
		Effect.flatMap(GitService, (svc) =>
			svc.reviewIdentity(folderId, worktreeId ?? null),
		),
);

const ListPrs = MemoizeRpcs.toLayerHandler("git.listPrs", ({ folderId }) =>
	Effect.flatMap(GitService, (svc) => svc.listPrs(folderId)),
);

const ListIssues = MemoizeRpcs.toLayerHandler(
	"git.listIssues",
	({ folderId }) =>
		Effect.flatMap(GitService, (svc) => svc.listIssues(folderId)),
);

const IssueMarkdown = MemoizeRpcs.toLayerHandler(
	"git.issueMarkdown",
	({ folderId, number }) =>
		Effect.flatMap(GitService, (svc) => svc.issueMarkdown(folderId, number)),
);

const Changes = MemoizeRpcs.toLayerHandler(
	"git.changes",
	({ folderId, worktreeId }) =>
		Effect.flatMap(GitService, (svc) =>
			svc.changes(folderId, worktreeId ?? null),
		),
);

const ReviewSummary = MemoizeRpcs.toLayerHandler(
	"git.reviewSummary",
	({ folderId, worktreeId, scope }) =>
		Effect.flatMap(GitService, (svc) =>
			svc.reviewSummary(folderId, worktreeId ?? null, scope ?? "branch"),
		),
);

const ReviewPatches = MemoizeRpcs.toLayerHandler(
	"git.reviewPatches",
	({ folderId, worktreeId, scope }) =>
		Stream.unwrap(
			Effect.map(GitService, (svc) =>
				svc.reviewPatches(folderId, worktreeId ?? null, scope ?? "branch"),
			),
		),
);

const ReviewFileContents = MemoizeRpcs.toLayerHandler(
	"git.reviewFileContents",
	({ folderId, worktreeId, path, oldPath }) =>
		Effect.flatMap(GitService, (svc) =>
			svc.reviewFileContents(
				folderId,
				path,
				oldPath ?? null,
				worktreeId ?? null,
			),
		),
);

const Diff = MemoizeRpcs.toLayerHandler(
	"git.diff",
	({ folderId, worktreeId, path }) =>
		Effect.flatMap(GitService, (svc) =>
			svc.diff(folderId, path, worktreeId ?? null),
		),
);

const Commit = MemoizeRpcs.toLayerHandler(
	"git.commit",
	({ folderId, worktreeId, message, paths }) =>
		Effect.flatMap(GitService, (svc) =>
			svc.commit(folderId, message, worktreeId ?? null, paths),
		),
);

const Push = MemoizeRpcs.toLayerHandler(
	"git.push",
	({ folderId, worktreeId }) =>
		Effect.flatMap(GitService, (svc) =>
			svc
				.push(folderId, worktreeId ?? null)
				.pipe(
					Effect.tap(() =>
						refreshPrSnapshot(svc, folderId, worktreeId ?? null),
					),
				),
		),
);

const Pull = MemoizeRpcs.toLayerHandler(
	"git.pull",
	({ folderId, worktreeId }) =>
		Effect.flatMap(GitService, (svc) => svc.pull(folderId, worktreeId ?? null)),
);

const Stash = MemoizeRpcs.toLayerHandler(
	"git.stash",
	({ folderId, worktreeId, message }) =>
		Effect.flatMap(GitService, (svc) =>
			svc.stash(folderId, message, worktreeId ?? null),
		),
);

const StashPop = MemoizeRpcs.toLayerHandler(
	"git.stashPop",
	({ folderId, worktreeId }) =>
		Effect.flatMap(GitService, (svc) =>
			svc.stashPop(folderId, worktreeId ?? null),
		),
);

const ResetRemotePreview = MemoizeRpcs.toLayerHandler(
	"git.resetRemotePreview",
	({ folderId, worktreeId }) =>
		Effect.flatMap(GitService, (svc) =>
			svc.resetRemotePreview(folderId, worktreeId ?? null),
		),
);

const ResetRemoteApply = MemoizeRpcs.toLayerHandler(
	"git.resetRemoteApply",
	({
		folderId,
		worktreeId,
		expectedHead,
		expectedRemoteHead,
		expectedWorktreeFingerprint,
		confirmationBranch,
	}) =>
		Effect.flatMap(GitService, (svc) =>
			svc.resetRemoteApply(
				folderId,
				expectedHead,
				expectedRemoteHead,
				expectedWorktreeFingerprint,
				confirmationBranch,
				worktreeId ?? null,
			),
		),
);

const ResolveConflict = MemoizeRpcs.toLayerHandler(
	"git.resolveConflict",
	({ folderId, worktreeId, path, contents }) =>
		Effect.flatMap(GitService, (svc) =>
			svc.resolveConflict(folderId, path, contents, worktreeId ?? null),
		),
);

const MergePr = MemoizeRpcs.toLayerHandler(
	"git.mergePr",
	({ folderId, worktreeId, action, method, deleteBranch }) =>
		Effect.flatMap(GitService, (svc) =>
			svc
				.mergePr(folderId, action, method, deleteBranch, worktreeId ?? null)
				.pipe(
					Effect.tap(() =>
						refreshPrSnapshot(svc, folderId, worktreeId ?? null),
					),
				),
		),
);

const MarkReady = MemoizeRpcs.toLayerHandler(
	"git.markReady",
	({ folderId, worktreeId, state }) =>
		Effect.flatMap(GitService, (svc) =>
			svc
				.markReady(folderId, worktreeId ?? null, state)
				.pipe(
					Effect.tap(() =>
						refreshPrSnapshot(svc, folderId, worktreeId ?? null),
					),
				),
		),
);

const RevertFile = MemoizeRpcs.toLayerHandler(
	"git.revertFile",
	({ folderId, worktreeId, path, oldPath, kind }) =>
		Effect.flatMap(GitService, (svc) =>
			svc.revertFile(folderId, path, kind, oldPath ?? null, worktreeId ?? null),
		),
);

const RevertAll = MemoizeRpcs.toLayerHandler(
	"git.revertAll",
	({ folderId, worktreeId }) =>
		Effect.flatMap(GitService, (svc) =>
			svc.revertAll(folderId, worktreeId ?? null),
		),
);

const RestoreFileToBase = MemoizeRpcs.toLayerHandler(
	"git.restoreFileToBase",
	({ folderId, worktreeId, path, oldPath }) =>
		Effect.flatMap(GitService, (svc) =>
			svc.restoreFileToBase(
				folderId,
				path,
				oldPath ?? null,
				worktreeId ?? null,
			),
		),
);

const Init = MemoizeRpcs.toLayerHandler("git.init", ({ folderId }) =>
	Effect.flatMap(GitService, (svc) => svc.init(folderId)),
);

const FixFailingChecks = MemoizeRpcs.toLayerHandler(
	"git.fixFailingChecks",
	({ folderId, worktreeId }) =>
		Effect.flatMap(GitService, (svc) =>
			svc.fixFailingChecks(folderId, worktreeId ?? null),
		),
);

export const GitHandlersLayer = Layer.mergeAll(
	Log,
	Status,
	Branches,
	SwitchBranch,
	ContinueBranch,
	Stack,
	UserName,
	WorkspaceChanges,
	WorkspaceSnapshot,
	Origin,
	PrState,
	PrNotificationClaim,
	PrDetails,
	CreateReviewComment,
	ReviewIdentity,
	ListPrs,
	ListIssues,
	IssueMarkdown,
	Changes,
	ReviewSummary,
	ReviewPatches,
	ReviewFileContents,
	Diff,
	Commit,
	Push,
	Pull,
	Stash,
	StashPop,
	ResetRemotePreview,
	ResetRemoteApply,
	ResolveConflict,
	MergePr,
	MarkReady,
	Init,
	RevertFile,
	RestoreFileToBase,
	RevertAll,
	FixFailingChecks,
);
