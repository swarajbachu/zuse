import type { FolderId, GitOriginInfo } from "@zuse/contracts";
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";

import { getConnectionClient, reportConnectionFailure } from "~/rpc/connection";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

import { appAtomRegistry, batchAtomUpdates } from "./registry";

export const projectOriginKey = (connKey: string, folderId: FolderId): string =>
	`${connKey}:${folderId}`;

export const projectOriginByKeyAtom = Atom.make<
	Record<string, GitOriginInfo | null>
>({}).pipe(Atom.keepAlive);
export const projectOriginLoadingByKeyAtom = Atom.make<
	Record<string, boolean>
>({}).pipe(Atom.keepAlive);

/** Per-project origin info; notifies only when this key's entry changes. */
export const projectOriginAtom = Atom.family((key: string) =>
	Atom.make((get) => get(projectOriginByKeyAtom)[key]),
);

export const hydrateProjectOrigin = async (
	connKey: string,
	options: WsProtocolOptions,
	folderId: FolderId,
): Promise<void> => {
	const key = projectOriginKey(connKey, folderId);
	if (
		appAtomRegistry.get(projectOriginByKeyAtom)[key] !== undefined ||
		appAtomRegistry.get(projectOriginLoadingByKeyAtom)[key]
	) {
		return;
	}

	appAtomRegistry.update(projectOriginLoadingByKeyAtom, (state) => ({
		...state,
		[key]: true,
	}));

	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		const origin = await Effect.runPromise(client["git.origin"]({ folderId }));
		batchAtomUpdates(() => {
			appAtomRegistry.update(projectOriginByKeyAtom, (state) => ({
				...state,
				[key]: origin,
			}));
			appAtomRegistry.update(projectOriginLoadingByKeyAtom, (state) => ({
				...state,
				[key]: false,
			}));
		});
	} catch (cause) {
		reportConnectionFailure(options, cause);
		batchAtomUpdates(() => {
			appAtomRegistry.update(projectOriginByKeyAtom, (state) => ({
				...state,
				[key]: null,
			}));
			appAtomRegistry.update(projectOriginLoadingByKeyAtom, (state) => ({
				...state,
				[key]: false,
			}));
		});
	}
};

export const resetProjectOriginRuntime = (): void => {
	batchAtomUpdates(() => {
		appAtomRegistry.set(projectOriginByKeyAtom, {});
		appAtomRegistry.set(projectOriginLoadingByKeyAtom, {});
	});
};
