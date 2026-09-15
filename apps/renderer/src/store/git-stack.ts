import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import { CommandId, type GitStackResult } from "@zuse/contracts";
import { dispatchGitWorkspaceCommand } from "../lib/git-workspace-client-bus.ts";
import { createAtomStore } from "../state/atom-store.ts";

type Entry = {
	readonly result: GitStackResult | null;
	readonly checkedAt: number;
};
export const gitStackKey = (ref: ExecutionRef, branch: string) =>
	JSON.stringify([ref.environmentId, ref.folderId, ref.worktreeId, branch]);
export const useGitStackStore = createAtomStore<{
	entries: Readonly<Record<string, Entry>>;
}>(() => ({ entries: {} }));
const pending = new Map<string, Promise<GitStackResult | null>>();

/** Share discovery between the branch menu and summary; absence is a normal state. */
export function readGitStack(
	ref: ExecutionRef,
	branch: string,
	force = false,
): Promise<GitStackResult | null> {
	const key = gitStackKey(ref, branch);
	const existing = pending.get(key);
	if (existing)
		return force
			? existing.then(
					() => readGitStack(ref, branch, true),
					() => readGitStack(ref, branch, true),
				)
			: existing;
	const cached = useGitStackStore.getState().entries[key];
	if (!force && cached && Date.now() - cached.checkedAt < 30_000)
		return Promise.resolve(cached.result);
	const request = dispatchGitWorkspaceCommand<
		{
			folderId: typeof ref.folderId;
			worktreeId: typeof ref.worktreeId;
			action: "view";
		},
		GitStackResult
	>({
		ref,
		kind: "git.stack",
		commandId: CommandId.make(`stack-view:${crypto.randomUUID()}`),
		payload: {
			folderId: ref.folderId,
			worktreeId: ref.worktreeId,
			action: "view",
		},
	})
		.then(({ result }) => result)
		.catch((cause: unknown) => {
			const reason =
				cause instanceof Error
					? cause.message
					: typeof cause === "object" && cause !== null && "reason" in cause
						? String(cause.reason)
						: "";
			if (
				/current branch is not part of (?:a |the )?stack|^no stack$/i.test(
					reason,
				)
			)
				return null;
			throw cause;
		})
		.then((result) => {
			const entries = Object.entries(useGitStackStore.getState().entries)
				.filter(([entryKey]) => entryKey !== key)
				.slice(-63);
			useGitStackStore.setState({
				entries: {
					...Object.fromEntries(entries),
					[key]: { result, checkedAt: Date.now() },
				},
			});
			return result;
		})
		.finally(() => pending.delete(key));
	pending.set(key, request);
	return request;
}
