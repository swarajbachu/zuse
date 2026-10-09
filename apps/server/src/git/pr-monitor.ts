import { type FolderId, GitPrInfo, type WorktreeId } from "@zuse/contracts";
import { GitService } from "@zuse/git/git-service";
import { GitHubRequestScope, type GitHubScope } from "@zuse/git/github-client";
import { makeWorkspaceChangeStreams } from "@zuse/git/workspace-change-streams";
import { Context, Effect, Layer, Queue, Stream } from "effect";
import {
	GitCheckoutProjectionState,
	gitCheckoutIdentity,
} from "./checkout-projection-state.ts";

export const emptyPrSnapshot = (branch: string | null): GitPrInfo =>
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
		stale: true,
	});

export const prMonitorDelay = (
	pr: GitPrInfo | undefined,
	visible: boolean,
): number => {
	if (pr?.retryAt && pr.retryAt.getTime() > Date.now())
		return Math.max(1000, pr.retryAt.getTime() - Date.now());
	if (pr?.prCapability === "authentication" || pr?.prCapability === "access")
		return 120_000;
	return visible
		? !pr ||
			pr.checks === "pending" ||
			pr.checks === "none" ||
			pr.mergeable === "unknown"
			? 45_000
			: 60_000
		: 120_000;
};

export class GitPrMonitor extends Context.Service<
	GitPrMonitor,
	{
		readonly snapshot: (
			folderId: FolderId,
			worktreeId: WorktreeId | null,
			branch: string | null,
			scopeKey?: string,
		) => GitPrInfo;
		readonly version: (
			folderId: FolderId,
			worktreeId: WorktreeId | null,
			scopeKey?: string,
		) => number;
		readonly refresh: (
			folderId: FolderId,
			worktreeId: WorktreeId | null,
			force?: boolean,
		) => Effect.Effect<void>;
		readonly changes: (
			folderId: FolderId,
			worktreeId: WorktreeId | null,
			visible: boolean,
		) => ReturnType<GitService["Service"]["workspaceChanges"]>;
	}
>()("zuse/git/GitPrMonitor") {}

export const GitPrMonitorLive = Layer.effect(
	GitPrMonitor,
	Effect.gen(function* () {
		const git = yield* GitService;
		const state = new GitCheckoutProjectionState<GitPrInfo>();
		const visibility = new Map<string, number>();
		const failures = new Map<string, number>();
		const refreshes = new Map<string, Effect.Effect<void>>();
		const scopes = new Map<string, GitHubScope>();
		const scopedIdentity = (
			folderId: FolderId,
			worktreeId: WorktreeId | null,
			scopeKey = "",
		) => `${gitCheckoutIdentity(folderId, worktreeId)}\0${scopeKey}`;
		const publishers = new Map<string, () => void>();
		const refresh = (
			folderId: FolderId,
			worktreeId: WorktreeId | null,
			force = false,
		): Effect.Effect<void> =>
			Effect.flatMap(GitHubRequestScope, (scope) =>
				Effect.suspend(() => {
					const identity = scopedIdentity(folderId, worktreeId, scope?.key);
					const previous = refreshes.get(identity);
					if (previous && !force) return previous;
					let sharedRefresh: Effect.Effect<void>;
					const token = state.beginPrRefresh(identity);
					const program = Effect.gen(function* () {
						if (force) failures.delete(identity);
						const observed = yield* git.prState(folderId, worktreeId, {
							interactive: force || (visibility.get(identity) ?? 0) > 0,
							force,
						});
						const count =
							observed.prCapability === "rate_limited"
								? (failures.get(identity) ?? 0)
								: observed.prCapability && observed.prCapability !== "available"
									? (failures.get(identity) ?? 0) + 1
									: 0;
						const committed = state.commitPrRefresh(token, {
							value: GitPrInfo.make({
								...observed,
								monitoringPaused: count >= 8,
							}),
							nextPollAt:
								Date.now() +
								prMonitorDelay(observed, (visibility.get(identity) ?? 0) > 0),
						});
						if (committed) {
							failures.set(identity, count);
							publishers.get(identity)?.();
						}
					}).pipe(
						Effect.catch(() =>
							Effect.sync(() => {
								const count = (failures.get(identity) ?? 0) + 1;
								const cached = state.getPrSnapshot(identity);
								const committed = state.commitPrRefresh(token, {
									value: GitPrInfo.make({
										...(cached?.value ?? emptyPrSnapshot(null)),
										stale: true,
										prCapability: "unknown",
										monitoringPaused: count >= 8,
									}),
									nextPollAt: Date.now() + 60_000,
								});
								if (committed) {
									failures.set(identity, count);
									publishers.get(identity)?.();
								}
							}),
						),
						Effect.ensuring(
							Effect.sync(() => {
								if (refreshes.get(identity) === sharedRefresh)
									refreshes.delete(identity);
							}),
						),
					);
					// Cached Effect shares completion without creating detached fibers.
					return Effect.cached(program).pipe(
						Effect.flatMap((shared) => {
							sharedRefresh = shared;
							refreshes.set(identity, shared);
							return shared;
						}),
					);
				}),
			);
		const shared = yield* makeWorkspaceChangeStreams(
			(folderId, worktreeId, scopeKey) =>
				Stream.unwrap(
					Effect.gen(function* () {
						const identity = scopedIdentity(folderId, worktreeId, scopeKey);
						failures.delete(identity);
						const cached = state.getPrSnapshot(identity);
						if (cached)
							state.setPrSnapshot(identity, {
								value: GitPrInfo.make({
									...cached.value,
									monitoringPaused: false,
								}),
								nextPollAt: 0,
							});
						const mailbox = yield* Queue.sliding<{ revision: number }>(1);
						let revision = 0;
						yield* Effect.acquireRelease(
							Effect.sync(() =>
								publishers.set(identity, () => {
									Queue.offerUnsafe(mailbox, { revision: ++revision });
								}),
							),
							() =>
								Effect.sync(() => {
									publishers.delete(identity);
									failures.delete(identity);
								}),
						);
						yield* Effect.forkScoped(
							Effect.forever(
								Effect.gen(function* () {
									if (
										(failures.get(identity) ?? 0) < 8 &&
										(state.getPrSnapshot(identity)?.nextPollAt ?? 0) <=
											Date.now()
									) {
										yield* refresh(folderId, worktreeId);
									}
									yield* Effect.sleep("1 second");
								}),
							),
						);
						return Stream.merge(
							git
								.workspaceChanges(folderId, worktreeId)
								.pipe(
									Stream.catch(() =>
										Stream.concat(Stream.make({ revision: 0 }), Stream.never),
									),
								),
							Stream.fromQueue(mailbox),
						).pipe(Stream.map(() => ({ revision: ++revision })));
					}),
				).pipe(
					Stream.provideService(
						GitHubRequestScope,
						scopes.get(scopeKey) ?? null,
					),
				),
		);
		return GitPrMonitor.of({
			snapshot: (folderId, worktreeId, branch, scopeKey) => {
				const identity = scopedIdentity(folderId, worktreeId, scopeKey);
				const cached = state.getPrSnapshot(identity);
				// Bind an initial read failure to the first locally observed branch without losing the error.
				if (
					cached?.value.branch === null &&
					branch !== null &&
					cached.value.prCapability === "unknown"
				) {
					const value = GitPrInfo.make({ ...cached.value, branch });
					state.setPrSnapshot(identity, { ...cached, value });
					return value;
				}
				if (cached && cached.value.branch !== branch) {
					state.setPrSnapshot(identity, {
						value: emptyPrSnapshot(branch),
						nextPollAt: 0,
					});
					failures.delete(identity);
					return emptyPrSnapshot(branch);
				}
				return cached?.value ?? emptyPrSnapshot(branch);
			},
			version: (folderId, worktreeId, scopeKey) =>
				state.nextProjectionVersion(
					scopedIdentity(folderId, worktreeId, scopeKey),
				),
			refresh,
			changes: (folderId, worktreeId, visible) =>
				Stream.unwrap(
					Effect.gen(function* () {
						const scope = yield* GitHubRequestScope;
						if (scope) {
							if (scopes.size >= 512)
								scopes.delete(scopes.keys().next().value ?? "");
							scopes.set(scope.key, scope);
						}
						const identity = scopedIdentity(folderId, worktreeId, scope?.key);
						yield* Effect.acquireRelease(
							Effect.sync(() =>
								visibility.set(
									identity,
									(visibility.get(identity) ?? 0) + (visible ? 1 : 0),
								),
							),
							() =>
								Effect.sync(() => {
									const count =
										(visibility.get(identity) ?? 0) - (visible ? 1 : 0);
									if (count > 0) visibility.set(identity, count);
									else visibility.delete(identity);
								}),
						);
						return shared.stream(folderId, worktreeId, scope?.key);
					}),
				),
		});
	}),
);
