import type { AgentAvailability } from "@zuse/contracts";
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";

import { fetchAgentAvailability } from "~/rpc/actions";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

import { appAtomRegistry, batchAtomUpdates } from "./registry";

/**
 * Per-connection availability report. `undefined` = never fetched, `null` =
 * fetched but the server doesn't support the RPC (old desktop) — callers
 * treat `null` as "no filtering, show the full catalog".
 */
export const availabilityByConnectionAtom = Atom.make<
	Record<string, readonly AgentAvailability[] | null | undefined>
>({}).pipe(Atom.keepAlive);
export const availabilityLoadingByConnectionAtom = Atom.make<
	Record<string, boolean>
>({}).pipe(Atom.keepAlive);

/** Per-connection report; notifies only when this connection's entry changes. */
export const connectionAvailabilityAtom = Atom.family((connKey: string) =>
	Atom.make((get) => get(availabilityByConnectionAtom)[connKey]),
);

export const hydrateAvailability = async (
	connKey: string,
	options: WsProtocolOptions,
): Promise<void> => {
	if (
		appAtomRegistry.get(availabilityByConnectionAtom)[connKey] !== undefined ||
		appAtomRegistry.get(availabilityLoadingByConnectionAtom)[connKey]
	) {
		return;
	}
	appAtomRegistry.update(availabilityLoadingByConnectionAtom, (state) => ({
		...state,
		[connKey]: true,
	}));
	const result = await Effect.runPromise(
		fetchAgentAvailability({ connection: options }),
	);
	batchAtomUpdates(() => {
		appAtomRegistry.update(availabilityByConnectionAtom, (state) => ({
			...state,
			[connKey]: result,
		}));
		appAtomRegistry.update(availabilityLoadingByConnectionAtom, (state) => ({
			...state,
			[connKey]: false,
		}));
	});
};

/** Drop the cached report so the next hydrate re-fetches (reconnect, etc.). */
export const invalidateAvailability = (connKey: string): void => {
	appAtomRegistry.update(availabilityByConnectionAtom, (state) => {
		if (state[connKey] === undefined) return state;
		const next = { ...state };
		delete next[connKey];
		return next;
	});
};

export const resetAvailabilityRuntime = (): void => {
	batchAtomUpdates(() => {
		appAtomRegistry.set(availabilityByConnectionAtom, {});
		appAtomRegistry.set(availabilityLoadingByConnectionAtom, {});
	});
};
