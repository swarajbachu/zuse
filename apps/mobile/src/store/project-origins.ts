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
export const projectOriginLoadingByKeyAtom = Atom.make<Record<string, boolean>>(
	{},
).pipe(Atom.keepAlive);
export const projectOriginAttemptGenerationByKeyAtom = Atom.make<
	Record<string, number>
>({}).pipe(Atom.keepAlive);

/** Per-project origin info; notifies only when this key's entry changes. */
export const projectOriginAtom = Atom.family((key: string) =>
	Atom.make((get) => get(projectOriginByKeyAtom)[key]),
);
export const projectOriginLoadingAtom = Atom.family((key: string) =>
	Atom.make((get) => get(projectOriginLoadingByKeyAtom)[key] ?? false),
);
export const projectOriginAttemptGenerationAtom = Atom.family((key: string) =>
	Atom.make((get) => get(projectOriginAttemptGenerationByKeyAtom)[key]),
);

export const hydrateProjectOrigin = async (
	connKey: string,
	options: WsProtocolOptions,
	folderId: FolderId,
	generation: number,
): Promise<void> => {
	const key = projectOriginKey(connKey, folderId);
	if (
		appAtomRegistry.get(projectOriginByKeyAtom)[key] !== undefined ||
		appAtomRegistry.get(projectOriginLoadingByKeyAtom)[key] ||
		appAtomRegistry.get(projectOriginAttemptGenerationByKeyAtom)[key] ===
			generation
	) {
		return;
	}

	batchAtomUpdates(() => {
		appAtomRegistry.update(projectOriginLoadingByKeyAtom, (state) => ({
			...state,
			[key]: true,
		}));
		appAtomRegistry.update(
			projectOriginAttemptGenerationByKeyAtom,
			(state) => ({
				...state,
				[key]: generation,
			}),
		);
	});

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
		// A transport failure is not proof that the project has no origin. Leave
		// it unresolved so the next connection generation can retry.
		appAtomRegistry.update(projectOriginLoadingByKeyAtom, (state) => ({
			...state,
			[key]: false,
		}));
	}
};

export const resetProjectOriginRuntime = (): void => {
	batchAtomUpdates(() => {
		appAtomRegistry.set(projectOriginByKeyAtom, {});
		appAtomRegistry.set(projectOriginLoadingByKeyAtom, {});
		appAtomRegistry.set(projectOriginAttemptGenerationByKeyAtom, {});
	});
};
