import {
	EnvironmentId,
	FolderId,
	GitNotARepoError,
	WorktreeId,
} from "@zuse/contracts";
import { Effect, Queue, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toastManager } from "../../src/components/ui/toast.tsx";
import {
	gitWorkspaceDriverStartsForTest,
	gitWorkspaceResourceKey,
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
			Queue.unbounded<{ revision: number }>(),
		);
		let streamStarts = 0;
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"git.workspaceChanges": () => {
						streamStarts += 1;
						return Stream.fromQueue(invalidations);
					},
					"git.status": () =>
						Effect.succeed({
							branch: "feature",
							ahead: 1,
							behind: 0,
							dirtyFiles: 2,
						}),
					"git.changes": () =>
						Effect.succeed([
							{
								path: "README.md",
								oldPath: null,
								staged: false,
								kind: "modified",
							},
						]),
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
						Effect.succeed({
							baseRef: "main",
							headRef: "feature",
							scope: "branch",
							baseSha: "base",
							headSha: "head",
							files: [],
							additions: 4,
							deletions: 1,
						}),
					"git.reviewPatches": () => Stream.empty,
					"git.prDetails": () =>
						Effect.succeed({
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
						}),
				}) as never,
		);

		const first = retainGitWorkspace(ref);
		const second = retainGitWorkspace(ref);
		await waitUntil(() => streamStarts === 1);
		Queue.offerUnsafe(invalidations, { revision: 0 });
		await waitUntil(
			() => getRendererClientBus().snapshot(first.key).sync === "live",
		);

		expect(streamStarts).toBe(1);
		expect(gitWorkspaceDriverStartsForTest()).toBe(1);
		expect(getRendererClientBus().snapshot(second.key)).toMatchObject({
			connection: "connected",
			sync: "live",
			data: {
				status: { branch: "feature", dirtyFiles: 2 },
				changes: [{ path: "README.md" }],
				diffStat: { additions: 4, deletions: 1 },
				revision: 0,
			},
		});
		first.lease.release();
		expect(streamStarts).toBe(1);
		second.lease.release();
	});

	it("qualifies identical checkouts by environment and root path", () => {
		const first = gitWorkspaceResourceKey(ref);
		const otherEnvironment = gitWorkspaceResourceKey({
			...ref,
			environmentId: EnvironmentId.make("other-environment"),
		});
		const otherRoot = gitWorkspaceResourceKey({ ...ref, rootPath: "/other" });

		expect(first).not.toEqual(otherEnvironment);
		expect(first).not.toEqual(otherRoot);
	});

	it("announces one PR terminal transition across multiple workspaces", async () => {
		const queues = new Map<string, Queue.Queue<{ revision: number }>>();
		let prState: "open" | "merged" = "open";
		const prInfo = () => ({
			state: prState,
			branch: "feature",
			baseBranch: "main",
			additions: 1,
			deletions: 0,
			number: 2050,
			url: "https://github.com/example/repo/pull/2050",
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
});
