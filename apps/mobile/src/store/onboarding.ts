import { Atom } from "effect/unstable/reactivity";
import * as SecureStore from "expo-secure-store";

import { appAtomRegistry, batchAtomUpdates } from "./registry";

const STORE_KEY = "zuse.mobile.onboarding.v1";

export const onboardingHydratedAtom = Atom.make(false).pipe(Atom.keepAlive);
export const onboardingCompleteAtom = Atom.make(false).pipe(Atom.keepAlive);

export const hydrateOnboarding = async (): Promise<void> => {
	let complete = false;
	try {
		complete = (await SecureStore.getItemAsync(STORE_KEY)) === "complete";
	} catch {
		// A temporarily unavailable keychain must not block startup.
	}
	batchAtomUpdates(() => {
		appAtomRegistry.set(onboardingCompleteAtom, complete);
		appAtomRegistry.set(onboardingHydratedAtom, true);
	});
};

export const completeOnboarding = async (): Promise<void> => {
	appAtomRegistry.set(onboardingCompleteAtom, true);
	await SecureStore.setItemAsync(STORE_KEY, "complete").catch(() => undefined);
};

export const clearOnboarding = async (): Promise<void> => {
	await SecureStore.deleteItemAsync(STORE_KEY);
	batchAtomUpdates(() => {
		appAtomRegistry.set(onboardingCompleteAtom, false);
		appAtomRegistry.set(onboardingHydratedAtom, true);
	});
};
