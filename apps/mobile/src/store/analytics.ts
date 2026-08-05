import { Atom } from "effect/unstable/reactivity";

import { hydrateMobileAnalytics } from "~/lib/analytics";

import { authAccountAtom } from "./auth";
import { appAtomRegistry, batchAtomUpdates } from "./registry";

export const analyticsHydratedAtom = Atom.make(false).pipe(Atom.keepAlive);

export const hydrateAnalytics = async (): Promise<void> => {
	if (appAtomRegistry.get(analyticsHydratedAtom)) return;
	const accountId = appAtomRegistry.get(authAccountAtom)?.id ?? null;
	await hydrateMobileAnalytics(accountId);
	batchAtomUpdates(() => {
		appAtomRegistry.set(analyticsHydratedAtom, true);
	});
};
