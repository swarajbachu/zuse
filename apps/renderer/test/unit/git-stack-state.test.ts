import { EnvironmentId, FolderId, GitStackResult } from "@zuse/contracts";
import { beforeEach, expect, test, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/git-workspace-client-bus.ts", () => ({
	dispatchGitWorkspaceCommand: dispatch,
}));

import {
	gitStackKey,
	readGitStack,
	useGitStackStore,
} from "../../src/store/git-stack.ts";

const ref = {
	environmentId: EnvironmentId.make("local"),
	folderId: FolderId.make("repo"),
	worktreeId: null,
	rootPath: "/repo",
};
const stack = GitStackResult.make({
	output: "",
	trunk: "main",
	branches: [
		{ name: "feature", isCurrent: true, isMerged: false, needsRebase: false },
	],
});
beforeEach(() => {
	useGitStackStore.setState({ entries: {} });
	dispatch.mockReset();
});

test("missing stacks are cached quietly and shared between summary and branch menu", async () => {
	dispatch.mockRejectedValue(
		new Error("current branch is not part of a stack"),
	);
	await expect(
		Promise.all([readGitStack(ref, "main"), readGitStack({ ...ref }, "main")]),
	).resolves.toEqual([null, null]);
	await expect(readGitStack(ref, "main")).resolves.toBeNull();
	expect(dispatch).toHaveBeenCalledOnce();
});

test("a stack created from the branch menu updates the summary and does not leak to another branch", async () => {
	dispatch.mockRejectedValueOnce(new Error("no stack"));
	await readGitStack(ref, "feature");
	dispatch.mockResolvedValueOnce({ result: stack });
	await readGitStack(ref, "feature", true);
	expect(
		useGitStackStore.getState().entries[gitStackKey(ref, "feature")]?.result,
	).toEqual(stack);
	expect(
		useGitStackStore.getState().entries[gitStackKey(ref, "main")],
	).toBeUndefined();
});

test("post-mutation discovery waits for an older probe and then fetches the new stack", async () => {
	let finish!: (value: { result: GitStackResult }) => void;
	dispatch.mockReturnValueOnce(
		new Promise((resolve) => {
			finish = resolve;
		}),
	);
	const probe = readGitStack(ref, "feature");
	const refresh = readGitStack(ref, "feature", true);
	dispatch.mockResolvedValueOnce({ result: stack });
	finish({
		result: GitStackResult.make({ output: "", trunk: "main", branches: [] }),
	});
	await probe;
	await expect(refresh).resolves.toEqual(stack);
	expect(dispatch).toHaveBeenCalledTimes(2);
});

test("transport failure is not cached as absence and the next probe retries", async () => {
	dispatch.mockRejectedValueOnce(new Error("Environment is not connected"));
	await expect(readGitStack(ref, "feature")).rejects.toThrow("not connected");
	expect(
		useGitStackStore.getState().entries[gitStackKey(ref, "feature")],
	).toBeUndefined();
	dispatch.mockResolvedValueOnce({ result: stack });
	await expect(readGitStack(ref, "feature")).resolves.toEqual(stack);
});

test("refresh failure preserves a previously discovered stack", async () => {
	dispatch.mockResolvedValueOnce({ result: stack });
	await readGitStack(ref, "feature");
	dispatch.mockRejectedValueOnce(new Error("server unavailable"));
	await expect(readGitStack(ref, "feature", true)).rejects.toThrow(
		"server unavailable",
	);
	expect(
		useGitStackStore.getState().entries[gitStackKey(ref, "feature")]?.result,
	).toEqual(stack);
});
