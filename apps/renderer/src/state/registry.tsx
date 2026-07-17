import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import type { ReactNode } from "react";
import { unstable_batchedUpdates } from "react-dom";

/** One renderer-wide registry. Domain hooks expose atoms; components never own it. */
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

/** Commit related domain changes before notifying React subscribers. */
export const batchAtomUpdates = (update: () => void): void => {
	Atom.batch(() => unstable_batchedUpdates(update));
};
