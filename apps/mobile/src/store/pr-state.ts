import type { FolderId, GitPrInfo, WorktreeId } from "@zuse/contracts";
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";

import { getConnectionClient, reportConnectionFailure } from "~/rpc/connection";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

import { appAtomRegistry, batchAtomUpdates } from "./registry";

export const prStateKey = (
	connKey: string,
	folderId: FolderId,
	worktreeId: WorktreeId | null,
): string => `${connKey}:${folderId}:${worktreeId ?? "main"}`;

export const prStateByKeyAtom = Atom.make<Record<string, GitPrInfo | null>>(
	{},
).pipe(Atom.keepAlive);
export const prStateLoadingByKeyAtom = Atom.make<Record<string, boolean>>(
	{},
).pipe(Atom.keepAlive);

/** Per-branch PR info; notifies only when this key's entry changes. */
export const prStateAtom = Atom.family((key: string) =>
	Atom.make((get) => get(prStateByKeyAtom)[key]),
);

export const hydratePrState = async (
	connKey: string,
	options: WsProtocolOptions,
	folderId: FolderId,
	worktreeId: WorktreeId | null,
): Promise<void> => {
	const key = prStateKey(connKey, folderId, worktreeId);
	if (
		appAtomRegistry.get(prStateByKeyAtom)[key] !== undefined ||
		appAtomRegistry.get(prStateLoadingByKeyAtom)[key]
	) {
		return;
	}

	appAtomRegistry.update(prStateLoadingByKeyAtom, (state) => ({
		...state,
		[key]: true,
	}));

	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		const info = await Effect.runPromise(
			client["git.prState"]({ folderId, worktreeId }),
		);
		batchAtomUpdates(() => {
			appAtomRegistry.update(prStateByKeyAtom, (state) => ({
				...state,
				[key]: info,
			}));
			appAtomRegistry.update(prStateLoadingByKeyAtom, (state) => ({
				...state,
				[key]: false,
			}));
		});
	} catch (cause) {
		reportConnectionFailure(options, cause);
		batchAtomUpdates(() => {
			appAtomRegistry.update(prStateByKeyAtom, (state) => ({
				...state,
				[key]: null,
			}));
			appAtomRegistry.update(prStateLoadingByKeyAtom, (state) => ({
				...state,
				[key]: false,
			}));
		});
	}
};

export const resetPrStateRuntime = (): void => {
	batchAtomUpdates(() => {
		appAtomRegistry.set(prStateByKeyAtom, {});
		appAtomRegistry.set(prStateLoadingByKeyAtom, {});
	});
};
