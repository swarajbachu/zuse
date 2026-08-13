import { EnvironmentId, FolderId, WorktreeId } from "@zuse/contracts";
import { Effect, Queue, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
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
					"git.diffStat": () => Effect.succeed({ additions: 4, deletions: 1 }),
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
});
