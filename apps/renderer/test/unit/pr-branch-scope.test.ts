import type { FolderId, GitPrInfo, WorktreeId } from "@zuse/contracts";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpcClientFactory } = vi.hoisted(() => ({
	rpcClientFactory: vi.fn(),
}));

vi.mock("../../src/lib/rpc-client.ts", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../src/lib/rpc-client.ts")>();
	return {
		...original,
		getRpcClient: async (environmentId?: unknown) =>
			rpcClientFactory(environmentId),
	};
});

import {
	gitDiffStatKey,
	useGitDiffStatStore,
} from "../../src/store/git-diff-stat.ts";
import { prStateKey, usePrStateStore } from "../../src/store/pr-state.ts";

const folderId = "folder-1" as FolderId;
const worktreeId = "wt-1" as WorktreeId;

const prInfo = (state: GitPrInfo["state"]): GitPrInfo =>
	({
		state,
		number: 7,
		branch: "feature",
		baseBranch: "main",
		additions: 3,
		deletions: 1,
		checks: "passing",
		mergeable: "mergeable",
	}) as unknown as GitPrInfo;

describe("environment-scoped PR state and diff stats", () => {
	beforeEach(() => {
		usePrStateStore.setState({ byKey: {} });
		useGitDiffStatStore.setState({ byKey: {} });
		rpcClientFactory.mockReset();
	});

	it("keys entries by environment so the same folder coexists per computer", () => {
		expect(prStateKey("env-a", folderId, worktreeId)).not.toBe(
			prStateKey("env-b", folderId, worktreeId),
		);
		expect(gitDiffStatKey("env-a", folderId, null)).not.toBe(
			gitDiffStatKey("env-b", folderId, null),
		);
	});

	it("hydrates each environment through that environment's client", async () => {
		const seen: unknown[] = [];
		rpcClientFactory.mockImplementation((environmentId: unknown) => {
			seen.push(environmentId);
			return {
				"git.prState": () => Effect.succeed(prInfo("open")),
				"git.diffStat": () => Effect.succeed({ additions: 5, deletions: 2 }),
			};
		});

		await usePrStateStore.getState().hydrate("env-a", folderId, worktreeId);
		await usePrStateStore.getState().hydrate("env-b", folderId, worktreeId);
		await useGitDiffStatStore.getState().hydrate("env-a", folderId, null);

		expect(seen).toEqual(["env-a", "env-b", "env-a"]);
		expect(
			usePrStateStore.getState().byKey[
				prStateKey("env-a", folderId, worktreeId)
			],
		).toEqual(prInfo("open"));
		expect(
			usePrStateStore.getState().byKey[
				prStateKey("env-b", folderId, worktreeId)
			],
		).toEqual(prInfo("open"));
		expect(
			useGitDiffStatStore.getState().byKey[
				gitDiffStatKey("env-a", folderId, null)
			],
		).toEqual({ additions: 5, deletions: 2 });
	});

	it("short-circuits repeat hydration per environment, not globally", async () => {
		rpcClientFactory.mockImplementation(() => ({
			"git.prState": () => Effect.succeed(prInfo("open")),
		}));

		await usePrStateStore.getState().hydrate("env-a", folderId, worktreeId);
		await usePrStateStore.getState().hydrate("env-a", folderId, worktreeId);
		expect(rpcClientFactory).toHaveBeenCalledTimes(1);

		await usePrStateStore.getState().hydrate("env-b", folderId, worktreeId);
		expect(rpcClientFactory).toHaveBeenCalledTimes(2);
	});
});
