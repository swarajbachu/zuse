import {
	type FolderId,
	Worktree,
	WorktreeId,
	WorktreeNotFoundError,
} from "@zuse/contracts";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { formatError } from "../../src/lib/format-error.ts";
import {
	setWorktreesRpcClientForTest,
	useWorktreesStore,
} from "../../src/store/worktrees.ts";

const projectId = "proj-1" as FolderId;
const worktreeId = WorktreeId.make("wt-1");
const now = new Date("2026-07-02T00:00:00.000Z");

const worktree = Worktree.make({
	id: worktreeId,
	projectId,
	path: "/tmp/zuse/proj-1/pikachu",
	name: "pikachu",
	branch: "swarajbachu/pikachu",
	baseBranch: "main",
	createdAt: now,
	setupStatus: "succeeded",
	setupOutput: "",
	setupStartedAt: null,
	setupFinishedAt: null,
	pokemon: null,
});

let removeCalls: Array<{
	readonly worktreeId: WorktreeId;
}> = [];

const setRemoveClient = (
	remove: (payload: {
		readonly worktreeId: WorktreeId;
	}) => Effect.Effect<void, unknown>,
) => {
	setWorktreesRpcClientForTest(
		async () =>
			({
				"worktree.remove": (payload: { readonly worktreeId: WorktreeId }) => {
					removeCalls.push(payload);
					return remove(payload);
				},
			}) as Awaited<
				ReturnType<typeof import("../../src/lib/rpc-client.ts").getRpcClient>
			>,
	);
};

describe("worktrees store removal", () => {
	beforeEach(() => {
		removeCalls = [];
		useWorktreesStore.setState({
			byProject: { [projectId]: [worktree] },
			loading: new Set(),
			creatingSetupByProject: new Set(),
			setupPending: new Set(),
			error: null,
		});
	});

	it("removes the row after checkpointing", async () => {
		setRemoveClient(() => Effect.void);

		const result = await useWorktreesStore
			.getState()
			.remove(projectId, worktreeId);

		expect(result).toEqual({ ok: true });
		expect(removeCalls).toEqual([{ worktreeId }]);
		expect(useWorktreesStore.getState().byProject[projectId]).toEqual([]);
	});

	it("formats id-only worktree errors as readable text", () => {
		expect(formatError(new WorktreeNotFoundError({ worktreeId }))).toBe(
			"Worktree not found.",
		);
	});
});
