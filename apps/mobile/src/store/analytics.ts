import { Atom } from "effect/unstable/reactivity";

import {
	hydrateMobileAnalytics,
	setMobileAnalyticsEnabled,
} from "~/lib/analytics";

import { authAccountAtom } from "./auth";
import { appAtomRegistry, batchAtomUpdates } from "./registry";

export const analyticsEnabledAtom = Atom.make(false).pipe(Atom.keepAlive);

export const analyticsHydratedAtom = Atom.make(false).pipe(Atom.keepAlive);

export const hydrateAnalytics = async (): Promise<void> => {
	if (appAtomRegistry.get(analyticsHydratedAtom)) return;
	const accountId = appAtomRegistry.get(authAccountAtom)?.id ?? null;
	const enabled = await hydrateMobileAnalytics(accountId);
	batchAtomUpdates(() => {
		appAtomRegistry.set(analyticsEnabledAtom, enabled);
		appAtomRegistry.set(analyticsHydratedAtom, true);
	});
};

export const setAnalyticsEnabled = async (enabled: boolean): Promise<void> => {
	if (!enabled) appAtomRegistry.set(analyticsEnabledAtom, false);
	await setMobileAnalyticsEnabled(
		enabled,
		appAtomRegistry.get(authAccountAtom)?.id ?? null,
	);
	appAtomRegistry.set(analyticsEnabledAtom, enabled);
};
