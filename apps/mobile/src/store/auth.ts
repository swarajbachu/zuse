import { Atom } from "effect/unstable/reactivity";
import {
	currentAccount,
	type WorkosAccount,
	signIn as workosSignIn,
	signOut as workosSignOut,
} from "../auth/workos.ts";
import { resetAiSharingConsent } from "../lib/ai-sharing-consent";
import { resetLocalMobileData } from "../lib/mobile-data.ts";
import { revokeCurrentDevicePush } from "../notifications/push";
import {
	deleteAccount as deleteApiAccount,
	resetApiAccessToken,
} from "../rpc/api-client.ts";
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
	let account: WorkosAccount | null = null;
	try {
		account = await currentAccount();
	} catch {
		// Keychain access can be temporarily unavailable after an install or
		// while the device is locked. Startup must still settle to signed out.
	}
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
		resetApiAccessToken();
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
	if (appAtomRegistry.get(authBusyAtom)) return;
	appAtomRegistry.set(authBusyAtom, true);
	appAtomRegistry.set(authErrorAtom, null);
	try {
		await revokeCurrentDevicePush();
		await workosSignOut();
		resetApiAccessToken();
		resetAiSharingConsent();
		appAtomRegistry.set(authAccountAtom, null);
	} catch {
		appAtomRegistry.set(
			authErrorAtom,
			"Could not finish signing out. Connect to the internet and retry so this device stops receiving account alerts.",
		);
	} finally {
		appAtomRegistry.set(authBusyAtom, false);
	}
};

export const resetApp = async (): Promise<void> => {
	if (appAtomRegistry.get(authBusyAtom))
		throw new Error("An account action is already in progress.");
	batchAtomUpdates(() => {
		appAtomRegistry.set(authBusyAtom, true);
		appAtomRegistry.set(authErrorAtom, null);
	});
	try {
		if (appAtomRegistry.get(authAccountAtom)) await revokeCurrentDevicePush();
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

export const deleteAccount = async (): Promise<{
	cleanupPending: boolean;
	localCleanupFailed: boolean;
}> => {
	if (appAtomRegistry.get(authBusyAtom))
		throw new Error("An account action is already in progress.");
	batchAtomUpdates(() => {
		appAtomRegistry.set(authBusyAtom, true);
		appAtomRegistry.set(authErrorAtom, null);
	});
	let cleanupPending: boolean;
	try {
		({ cleanupPending } = await deleteApiAccount());
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
		return { cleanupPending, localCleanupFailed: false };
	} catch (cause) {
		batchAtomUpdates(() => {
			appAtomRegistry.set(authAccountAtom, null);
			appAtomRegistry.set(authBusyAtom, false);
			appAtomRegistry.set(
				authErrorAtom,
				`Account deletion accepted. ${message(cause)}`,
			);
		});
		return { cleanupPending, localCleanupFailed: true };
	}
};
