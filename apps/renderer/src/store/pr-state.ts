import type { FolderId, GitPrInfo, WorktreeId } from "@zuse/contracts";
import { Effect } from "effect";
import { toastManager } from "../components/ui/toast.tsx";
import { getRpcClient } from "../lib/rpc-client.ts";
import { createAtomStore as create } from "../state/atom-store.ts";

/**
 * PR state cache. Source of truth for the sidebar branch icon color and the
 * diff-stats slot on the session row. Hydrated lazily when a project is
 * expanded or a session row mounts; refreshed after a turn finishes
 * (running → idle/closed) and on-demand from the chat composer.
 *
 * Keyed by `(environmentId, folderId, worktreeId)`: each worktree has its
 * own branch and therefore its own PR, and the same folder id on two
 * computers is two different checkouts. Environment-scoped keys let rows
 * from every computer keep their PR state at once, so this store is NOT
 * part of the environment snapshot swap.
 */
type PrStateMap = Record<string, GitPrInfo>;

type PrState = {
	readonly byKey: PrStateMap;
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

export const prStateKey = (
	environmentId: string,
	folderId: FolderId,
	worktreeId: WorktreeId | null | undefined,
): string => `${environmentId}\u0001${folderId}:${worktreeId ?? "main"}`;

const fetchPrState = async (
	environmentId: string,
	folderId: FolderId,
	worktreeId: WorktreeId | null | undefined,
): Promise<GitPrInfo | null> => {
	try {
		const client = await getRpcClient(environmentId);
		const info = await Effect.runPromise(
			client["git.prState"]({ folderId, worktreeId: worktreeId ?? null }),
		);
		return info;
	} catch {
		// gh missing, no PR, no remote, env offline — absence reads as "none".
		return null;
	}
};

const prLabel = (info: GitPrInfo): string =>
	info.number === null ? "Pull request" : `Pull request #${info.number}`;

const prDescription = (info: GitPrInfo): string => {
	if (info.branch !== null && info.baseBranch !== null) {
		return `${info.branch} into ${info.baseBranch}`;
	}
	if (info.branch !== null) return info.branch;
	return "";
};

const notifyPrStateTransition = (
	previous: GitPrInfo | undefined,
	next: GitPrInfo,
): void => {
	if (previous === undefined) return;
	if (previous.state !== "open" || next.state === previous.state) return;

	if (next.state === "merged") {
		toastManager.add({
			type: "success",
			title: `${prLabel(next)} merged`,
			description: prDescription(next),
		});
		return;
	}

	if (next.state === "closed") {
		toastManager.add({
			type: "info",
			title: `${prLabel(next)} closed`,
			description: prDescription(next),
		});
	}
};

export const usePrStateStore = create<PrState>((set, get) => ({
	byKey: {},
	hydrate: async (environmentId, folderId, worktreeId) => {
		const key = prStateKey(environmentId, folderId, worktreeId);
		const existing = get().byKey[key];
		if (existing !== undefined && existing.state !== "none") return;
		const info = await fetchPrState(environmentId, folderId, worktreeId);
		if (info === null) return;
		set((s) => ({ byKey: { ...s.byKey, [key]: info } }));
	},
	refresh: async (environmentId, folderId, worktreeId) => {
		const info = await fetchPrState(environmentId, folderId, worktreeId);
		if (info === null) return;
		const key = prStateKey(environmentId, folderId, worktreeId);
		set((s) => {
			notifyPrStateTransition(s.byKey[key], info);
			return { byKey: { ...s.byKey, [key]: info } };
		});
	},
}));
