import { resourceKeyId } from "@zuse/client-runtime/resource-ref";
import {
	EnvironmentId,
	FolderId,
	GitNotARepoError,
	type GitReviewPatch,
	WorktreeId,
} from "@zuse/contracts";
import { Effect, PubSub, Queue, Stream } from "effect";
import {
	RpcClientDefect,
	RpcClientError,
} from "effect/unstable/rpc/RpcClientError";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toastManager } from "../../src/components/ui/toast.tsx";
import {
	gitWorkspaceDriverStartsForTest,
	gitWorkspaceResourceKey,
	refreshGitPrDetails,
	refreshGitReview,
	refreshGitWorkspace,
	resetGitWorkspaceClientBusForTest,
	retainGitWorkspace,
} from "../../src/lib/git-workspace-client-bus.ts";
import {
	getRendererClientBus,
	resetSessionTimelineClientBusForTest,
	setSessionTimelineRpcClientForTest,
} from "../../src/lib/session-timeline-client-bus.ts";

const waitUntil = async (predicate: () => boolean): Promise<void> => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not reached");
};

const folderId = FolderId.make("git-project");
const worktreeId = WorktreeId.make("git-worktree");
const environmentId = EnvironmentId.make("git-environment");
const ref = {
	environmentId,
	folderId,
	worktreeId,
	rootPath: "/project/worktree",
} as const;

describe("renderer Git workspace ClientBus adapter", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		resetGitWorkspaceClientBusForTest();
		resetSessionTimelineClientBusForTest();
	});

	it("shares one invalidation stream and canonical snapshot across consumers", async () => {
		const invalidations = Effect.runSync(
			PubSub.unbounded<{ revision: number }>(),
		);
		let streamStarts = 0;
		let snapshotLoads = 0;
		let changeLoads = 0;
		let reviewSummaryLoads = 0;
		let reviewPatchLoads = 0;
		let prDetailsLoads = 0;
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"git.workspaceChanges": () => {
						streamStarts += 1;
						return Stream.fromPubSub(invalidations);
					},
					"git.workspaceSnapshot": () =>
						Effect.sync(() => {
							snapshotLoads += 1;
							return {
								status: {
									branch: "feature",
									ahead: 1,
									behind: 0,
									dirtyFiles: 2,
								},
								changes: [
									{
										path: "README.md",
										oldPath: null,
										staged: false,
										kind: "modified" as const,
									},
								],
								reviewSummary: {
									baseRef: "main",
									headRef: "feature",
									scope: "branch" as const,
									baseSha: "base",
									headSha: "head",
									files: [],
									additions: 4,
									deletions: 1,
								},
								pr: {
									state: "none",
									branch: "feature",
									baseBranch: "main",
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
								},
								diffStat: { additions: 4, deletions: 1 },
								projectionVersion: 1,
								localFingerprint: "local-1",
								observedAt: new Date(),
							};
						}),
					"git.status": () =>
						Effect.succeed({
							branch: "feature",
							ahead: 1,
							behind: 0,
							dirtyFiles: 2,
						}),
					"git.changes": () => {
						changeLoads += 1;
						return Effect.succeed([
							{
								path: "README.md",
								oldPath: null,
								staged: false,
								kind: "modified",
							},
						]);
					},
					"git.prState": () =>
						Effect.succeed({
							state: "none",
							branch: "feature",
							baseBranch: "main",
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
						}),
					"git.reviewSummary": () =>
						Effect.sync(() => {
							reviewSummaryLoads += 1;
							return {
								baseRef: "main",
								headRef: "stale-separate-view",
								scope: "branch",
								baseSha: "base",
								headSha: "head",
								files: [],
								additions: 4,
								deletions: 1,
							};
						}),
					"git.reviewPatches": () => {
						reviewPatchLoads += 1;
						return Stream.empty;
					},
					"git.prDetails": () => {
						prDetailsLoads += 1;
						return Effect.succeed({
							state: "none",
							number: null,
							url: null,
							isDraft: false,
							checks: "none",
							mergeable: "unknown",
							additions: 0,
							deletions: 0,
							title: "",
							body: "",
							author: "",
							baseBranch: null,
							headBranch: null,
							comments: [],
							reviews: [],
							files: [],
							checkRuns: [],
						});
					},
				}) as never,
		);

		const first = retainGitWorkspace(ref);
		const second = retainGitWorkspace(ref);
		const third = retainGitWorkspace(ref);
		const fourth = retainGitWorkspace(ref);
		const bus = getRendererClientBus();
		await waitUntil(() => streamStarts === 1);
		PubSub.publishUnsafe(invalidations, { revision: 0 });
		await waitUntil(() => bus.snapshot(first.key).sync === "live");

		expect(streamStarts).toBe(1);
		expect(gitWorkspaceDriverStartsForTest()).toBe(1);
		expect(snapshotLoads).toBe(1);
		expect(reviewPatchLoads).toBe(0);
		expect(prDetailsLoads).toBe(0);
		expect(changeLoads).toBe(0);
		expect(reviewSummaryLoads).toBe(0);
		expect(bus.snapshot(first.key)).toMatchObject({
			connection: "connected",
			sync: "live",
			data: {
				status: { branch: "feature", dirtyFiles: 2 },
				changes: [{ path: "README.md", kind: "modified" }],
				reviewSummary: { headRef: "feature", additions: 4, deletions: 1 },
				diffStat: { additions: 4, deletions: 1 },
				revision: 0,
			},
		});

		await Promise.all([
			refreshGitWorkspace(ref),
			refreshGitReview(ref),
			refreshGitPrDetails(ref),
		]);
		expect(snapshotLoads).toBe(2);
		expect(streamStarts).toBe(1);
		expect(changeLoads).toBe(0);
		expect(reviewSummaryLoads).toBe(0);
		expect(reviewPatchLoads).toBe(0);
		expect(prDetailsLoads).toBe(0);
		first.lease.release();
		second.lease.release();
		third.lease.release();
		fourth.lease.release();
	});

	it("qualifies checkouts by environment and canonical folder/worktree identity", () => {
		const first = gitWorkspaceResourceKey(ref);
		const otherEnvironment = gitWorkspaceResourceKey({
			...ref,
			environmentId: EnvironmentId.make("other-environment"),
		});
		const otherRoot = gitWorkspaceResourceKey({ ...ref, rootPath: "/other" });

		expect(resourceKeyId(first)).not.toBe(resourceKeyId(otherEnvironment));
		expect(resourceKeyId(first)).toBe(resourceKeyId(otherRoot));
	});

	it("rejects a lazy patch response from an older workspace revision", async () => {
		const invalidations = Effect.runSync(
			PubSub.unbounded<{ revision: number }>(),
		);
		let observedRevision = 0;
		let snapshotLoads = 0;
		let patchStarts = 0;
		let resolvePatch: (patch: GitReviewPatch) => void = () => {
			throw new Error("patch resolver was not initialized");
		};
		const patch = new Promise<GitReviewPatch>((resolve) => {
			resolvePatch = resolve;
		});
		const snapshot = () => ({
			status: {
				branch: "feature",
				ahead: 0,
				behind: 0,
				dirtyFiles: 1,
			},
			changes: [
				{
					path: "README.md",
					oldPath: null,
					staged: false,
					kind: "modified" as const,
				},
			],
			reviewSummary: {
				baseRef: "main",
				headRef: "feature",
				scope: "branch" as const,
				baseSha: "base",
				headSha: "head",
				files: [
					{
						path: "README.md",
						oldPath: null,
						kind: "modified" as const,
						additions: 1,
						deletions: 0,
						binary: false,
						conflict: false,
						hasUncommittedChanges: true,
					},
				],
				additions: 1,
				deletions: 0,
			},
			pr: {
				state: "none" as const,
				branch: "feature",
				baseBranch: "main",
				additions: 0,
				deletions: 0,
				number: null,
				url: null,
				isDraft: false,
				checks: "none" as const,
				mergeable: "unknown" as const,
				checksTotal: 0,
				checksRunning: 0,
				checksPassing: 0,
				checksFailing: 0,
				autoMergeEnabled: false,
			},
			diffStat: { additions: 1, deletions: 0 },
			projectionVersion: observedRevision,
			localFingerprint: `local-${observedRevision}`,
			observedAt: new Date(),
		});
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"git.workspaceChanges": () => Stream.fromPubSub(invalidations),
					"git.workspaceSnapshot": () =>
						Effect.sync(() => {
							snapshotLoads += 1;
							return snapshot();
						}),
					"git.reviewPatches": () => {
						patchStarts += 1;
						return Stream.fromEffect(Effect.promise(() => patch));
					},
				}) as never,
		);

		const retained = retainGitWorkspace(ref);
		await waitUntil(() => gitWorkspaceDriverStartsForTest() === 1);
		PubSub.publishUnsafe(invalidations, { revision: 0 });
		await waitUntil(() => snapshotLoads === 1);
		const initial = getRendererClientBus().snapshot(retained.key);
		getRendererClientBus().update(retained.key, {
			expectedGeneration: initial.generation,
			expectedCursor: initial.cursor,
			update: (data) => ({
				...data,
				reviewPatches: {
					"README.md": {
						path: "README.md",
						result: {
							mode: "worktree" as const,
							patch: "+cached",
							truncated: false,
							bytes: 7,
						},
						error: null,
					},
				},
				reviewPatchesRevision: data.revision,
			}),
		});

		observedRevision = 1;
		const hydration = refreshGitReview(ref);
		await waitUntil(() => snapshotLoads === 2 && patchStarts === 1);
		observedRevision = 2;
		PubSub.publishUnsafe(invalidations, { revision: 2 });
		await waitUntil(
			() =>
				getRendererClientBus().snapshot(retained.key).data
					?.projectionVersion === 2,
		);
		resolvePatch({
			path: "README.md",
			result: {
				mode: "worktree",
				patch: "+stale",
				truncated: false,
				bytes: 6,
			},
			error: null,
		});
		await hydration;

		expect(getRendererClientBus().snapshot(retained.key).data).toMatchObject({
			status: { branch: "feature" },
			changes: [{ path: "README.md" }],
			reviewSummary: { headSha: "head", additions: 1 },
			reviewPatches: {},
			projectionVersion: 2,
		});
		retained.lease.release();
	});

	it("announces one PR terminal transition across multiple workspaces", async () => {
		const queues = new Map<string, Queue.Queue<{ revision: number }>>();
		let prState: "open" | "merged" = "open";
		let notificationClaimed = false;
		const prInfo = () => ({
			state: prState,
			branch: "feature",
			baseBranch: "main",
			additions: 1,
			deletions: 0,
			number: 2050,
			url: "https://github.com/example/repo/pull/2050",
			nodeId: "PR_kwDO2050",
			isDraft: false,
			checks: "success" as const,
			mergeable: "clean" as const,
			checksTotal: 1,
			checksRunning: 0,
			checksPassing: 1,
			checksFailing: 0,
			autoMergeEnabled: false,
		});
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"git.workspaceChanges": ({
						worktreeId: requestedId,
					}: {
						readonly worktreeId?: WorktreeId | null;
					}) => {
						const queue = Effect.runSync(
							Queue.unbounded<{ revision: number }>(),
						);
						queues.set(requestedId ?? "main", queue);
						return Stream.fromQueue(queue);
					},
					"git.workspaceSnapshot": () =>
						Effect.succeed({
							status: { branch: "feature", ahead: 0, behind: 0, dirtyFiles: 0 },
							changes: [],
							reviewSummary: {
								baseRef: "main",
								headRef: "feature",
								scope: "branch",
								baseSha: "base",
								headSha: "head",
								files: [],
								additions: 1,
								deletions: 0,
							},
							pr: prInfo(),
							diffStat: { additions: 1, deletions: 0 },
							projectionVersion: 1,
							localFingerprint: "local-1",
							observedAt: new Date(),
						}),
					"git.status": () =>
						Effect.succeed({
							branch: "feature",
							ahead: 0,
							behind: 0,
							dirtyFiles: 0,
						}),
					"git.changes": () => Effect.succeed([]),
					"git.prState": () => Effect.succeed(prInfo()),
					"git.reviewSummary": () =>
						Effect.succeed({
							baseRef: "main",
							headRef: "feature",
							scope: "branch",
							baseSha: "base",
							headSha: "head",
							files: [],
							additions: 1,
							deletions: 0,
						}),
					"git.reviewPatches": () => Stream.empty,
					"git.prDetails": () =>
						Effect.fail(new GitNotARepoError({ folderId })),
					"git.prNotification.claim": () =>
						Effect.sync(() => {
							if (notificationClaimed) return { claimed: false };
							notificationClaimed = true;
							return { claimed: true };
						}),
				}) as never,
		);
		const addToast = vi.spyOn(toastManager, "add");
		const otherRef = {
			...ref,
			worktreeId: WorktreeId.make("git-worktree-2"),
			rootPath: "/project/worktree-2",
		};
		const first = retainGitWorkspace(ref);
		const second = retainGitWorkspace(otherRef);
		await waitUntil(() => queues.size === 2);
		for (const queue of queues.values()) {
			Queue.offerUnsafe(queue, { revision: 0 });
		}
		await waitUntil(
			() =>
				getRendererClientBus().snapshot(first.key).data?.pr?.state === "open" &&
				getRendererClientBus().snapshot(second.key).data?.pr?.state === "open",
		);

		prState = "merged";
		for (const queue of queues.values()) {
			Queue.offerUnsafe(queue, { revision: 1 });
		}
		await waitUntil(
			() =>
				getRendererClientBus().snapshot(first.key).data?.pr?.state ===
					"merged" &&
				getRendererClientBus().snapshot(second.key).data?.pr?.state ===
					"merged",
		);
		expect(addToast).toHaveBeenCalledTimes(1);
		first.lease.release();
		second.lease.release();
	});

	it("keeps a non-Git folder failure scoped to its Git resource", async () => {
		const notARepository = () =>
			Effect.fail(new GitNotARepoError({ folderId }));
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"git.workspaceChanges": () =>
						Stream.fail(new GitNotARepoError({ folderId })),
					"git.workspaceSnapshot": notARepository,
					"git.status": notARepository,
					"git.changes": notARepository,
					"git.prState": notARepository,
					"git.reviewSummary": notARepository,
					"git.reviewPatches": () => Stream.never,
					"git.prDetails": notARepository,
				}) as never,
		);

		const retained = retainGitWorkspace(ref);
		await waitUntil(
			() => getRendererClientBus().snapshot(retained.key).data !== null,
		);

		expect(getRendererClientBus().snapshot(retained.key)).toMatchObject({
			connection: "connected",
			sync: "live",
			data: {
				noRepository: true,
				error: { tag: "GitNotARepoError" },
			},
		});
		retained.lease.release();
	});

	it("does not reconnect the environment for a malformed Git snapshot", async () => {
		const invalidations = Effect.runSync(
			Queue.unbounded<{ revision: number }>(),
		);
		const defect = new RpcClientError({
			reason: new RpcClientDefect({
				message: "Expected GitWorkspaceSnapshot",
				cause: null,
			}),
		});
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"git.workspaceChanges": () => Stream.fromQueue(invalidations),
					"git.workspaceSnapshot": () => Effect.fail(defect),
				}) as never,
		);

		const retained = retainGitWorkspace(ref);
		await waitUntil(
			() =>
				getRendererClientBus().snapshot(retained.key).connection ===
				"connected",
		);
		Queue.offerUnsafe(invalidations, { revision: 0 });
		await waitUntil(
			() => getRendererClientBus().snapshot(retained.key).sync === "failed",
		);

		expect(getRendererClientBus().snapshot(retained.key).connection).toBe(
			"connected",
		);
		expect(gitWorkspaceDriverStartsForTest()).toBe(1);
		retained.lease.release();
	});
});
