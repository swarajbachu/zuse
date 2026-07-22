import { Atom } from "effect/unstable/reactivity";

import {
	currentAccount,
	type WorkosAccount,
	signIn as workosSignIn,
	signOut as workosSignOut,
} from "../auth/workos.ts";
import { resetLocalMobileData } from "../lib/mobile-data.ts";
import {
	deleteAccount as deleteRelayAccount,
	resetRelayAccessToken,
} from "../rpc/relay-client.ts";
import { appAtomRegistry, batchAtomUpdates } from "./registry.tsx";

export const authHydratedAtom = Atom.make(false).pipe(Atom.keepAlive);
export const authAccountAtom = Atom.make<WorkosAccount | null>(null).pipe(
	Atom.keepAlive,
);
export const authBusyAtom = Atom.make(false).pipe(Atom.keepAlive);
export const authErrorAtom = Atom.make<string | null>(null).pipe(
	Atom.keepAlive,
);

const message = (cause: unknown): string => {
	const text = cause instanceof Error ? cause.message : String(cause);
	if (text === "workos_sign_in_cancelled")
		return "Remote sign-in was cancelled.";
	if (text.startsWith("workos_authenticate_")) {
		return "Remote access could not complete sign-in. Check the account setup and try again.";
	}
	return text;
};

export const hydrateAuth = async (): Promise<void> => {
	const account = await currentAccount();
	batchAtomUpdates(() => {
		appAtomRegistry.set(authAccountAtom, account);
		appAtomRegistry.set(authHydratedAtom, true);
	});
};

export const signIn = async (): Promise<void> => {
	batchAtomUpdates(() => {
		appAtomRegistry.set(authBusyAtom, true);
		appAtomRegistry.set(authErrorAtom, null);
	});
	try {
		const account = await workosSignIn();
		batchAtomUpdates(() => {
			appAtomRegistry.set(authAccountAtom, account);
			appAtomRegistry.set(authBusyAtom, false);
		});
	} catch (cause) {
		batchAtomUpdates(() => {
			appAtomRegistry.set(authBusyAtom, false);
			appAtomRegistry.set(authErrorAtom, message(cause));
		});
	}
};

export const signOut = async (): Promise<void> => {
	await workosSignOut();
	resetRelayAccessToken();
	appAtomRegistry.set(authAccountAtom, null);
};

export const resetApp = async (): Promise<void> => {
	batchAtomUpdates(() => {
		appAtomRegistry.set(authBusyAtom, true);
		appAtomRegistry.set(authErrorAtom, null);
	});
	try {
		await resetLocalMobileData();
		batchAtomUpdates(() => {
			appAtomRegistry.set(authAccountAtom, null);
			appAtomRegistry.set(authBusyAtom, false);
			appAtomRegistry.set(authErrorAtom, null);
		});
	} catch (cause) {
		batchAtomUpdates(() => {
			appAtomRegistry.set(authBusyAtom, false);
			appAtomRegistry.set(authErrorAtom, message(cause));
		});
		throw cause;
	}
};

export const deleteAccount = async (): Promise<void> => {
	batchAtomUpdates(() => {
		appAtomRegistry.set(authBusyAtom, true);
		appAtomRegistry.set(authErrorAtom, null);
	});
	try {
		await deleteRelayAccount();
	} catch (cause) {
		batchAtomUpdates(() => {
			appAtomRegistry.set(authBusyAtom, false);
			appAtomRegistry.set(authErrorAtom, message(cause));
		});
		throw cause;
	}
	try {
		await resetLocalMobileData();
		batchAtomUpdates(() => {
			appAtomRegistry.set(authAccountAtom, null);
			appAtomRegistry.set(authBusyAtom, false);
			appAtomRegistry.set(authErrorAtom, null);
		});
	} catch (cause) {
		batchAtomUpdates(() => {
			appAtomRegistry.set(authAccountAtom, null);
			appAtomRegistry.set(authBusyAtom, false);
			appAtomRegistry.set(authErrorAtom, `Account deleted. ${message(cause)}`);
		});
	}
};
