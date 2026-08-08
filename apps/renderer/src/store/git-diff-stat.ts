import type { FolderId, WorktreeId } from "@zuse/contracts";
import { Effect } from "effect";
import { getRpcClient } from "../lib/rpc-client.ts";
import { createAtomStore as create } from "../state/atom-store.ts";

/**
 * Per-branch diff-stat cache: total additions/deletions of a worktree's
 * branch (including uncommitted edits) vs the repo's base branch. Source of
 * truth for the projects sidebar's `+N −N` slot, which shows a branch's diff
 * even before a PR exists. Keyed by `(environmentId, folderId, worktreeId)`
 * because each worktree owns its own branch and folders live on specific
 * computers. Environment-scoped keys let rows from every computer keep
 * their stats at once, so this store is NOT part of the environment
 * snapshot swap. Hydrated lazily when a chat row mounts and refreshed
 * alongside `git.changes` after commits/reverts.
 */
export type GitDiffStat = {
	readonly additions: number;
	readonly deletions: number;
};

type DiffStatMap = Record<string, GitDiffStat>;

type DiffStatState = {
	readonly byKey: DiffStatMap;
	readonly hydrate: (
		environmentId: string,
		folderId: FolderId,
		worktreeId?: WorktreeId | null,
	) => Promise<void>;
	readonly refresh: (
		environmentId: string,
		folderId: FolderId,
		worktreeId?: WorktreeId | null,
	) => Promise<void>;
};

export const gitDiffStatKey = (
	environmentId: string,
	folderId: FolderId,
	worktreeId: WorktreeId | null | undefined,
): string => `${environmentId}\u0001${folderId}:${worktreeId ?? "main"}`;

const fetchDiffStat = async (
	environmentId: string,
	folderId: FolderId,
	worktreeId: WorktreeId | null | undefined,
): Promise<GitDiffStat | null> => {
	try {
		const client = await getRpcClient(environmentId);
		return await Effect.runPromise(
			client["git.diffStat"]({ folderId, worktreeId: worktreeId ?? null }),
		);
	} catch {
		// Not a repo, git missing, env offline — caller treats as "no stats".
		return null;
	}
};

export const useGitDiffStatStore = create<DiffStatState>((set, get) => ({
	byKey: {},
	hydrate: async (environmentId, folderId, worktreeId) => {
		const key = gitDiffStatKey(environmentId, folderId, worktreeId);
		if (key in get().byKey) return;
		const stat = await fetchDiffStat(environmentId, folderId, worktreeId);
		if (stat === null) return;
		set((s) => ({ byKey: { ...s.byKey, [key]: stat } }));
	},
	refresh: async (environmentId, folderId, worktreeId) => {
		const stat = await fetchDiffStat(environmentId, folderId, worktreeId);
		if (stat === null) return;
		const key = gitDiffStatKey(environmentId, folderId, worktreeId);
		set((s) => ({ byKey: { ...s.byKey, [key]: stat } }));
	},
}));
