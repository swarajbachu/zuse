import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import type { ReactNode } from "react";

import { batchReactUpdates } from "./batching";

/**
 * One app-wide registry. State atoms live at module level and actions are
 * module functions that write through this registry, so React components and
 * imperative callers (notifications, connectivity runtime) share one source
 * of truth. Kept mobile-local on purpose: the renderer's sibling
 * (apps/renderer/src/state/registry.tsx) differs only in its batching import
 * (react-dom vs react-native), which is too little to justify a shared
 * package while the renderer still runs its Zustand-compat shim.
 */
export const appAtomRegistry = AtomRegistry.make();

export function AppAtomProvider({
	children,
}: {
	readonly children: ReactNode;
}) {
	return (
		<RegistryContext.Provider value={appAtomRegistry}>
			{children}
		</RegistryContext.Provider>
	);
}

/** Commit related domain writes before notifying React subscribers. */
export const batchAtomUpdates = (update: () => void): void => {
	Atom.batch(() => batchReactUpdates(update));
};
