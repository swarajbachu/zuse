import { create } from "zustand";
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

type AuthState = {
	hydrated: boolean;
	account: WorkosAccount | null;
	busy: boolean;
	error: string | null;
	hydrate: () => Promise<void>;
	signIn: () => Promise<void>;
	signOut: () => Promise<void>;
	resetApp: () => Promise<void>;
	deleteAccount: () => Promise<void>;
};

const message = (cause: unknown): string => {
	const text = cause instanceof Error ? cause.message : String(cause);
	if (text === "workos_sign_in_cancelled")
		return "Remote sign-in was cancelled.";
	if (text.startsWith("workos_authenticate_")) {
		return "Remote access could not complete sign-in. Check the account setup and try again.";
	}
	return text;
};

export const useAuthStore = create<AuthState>((set) => ({
	hydrated: false,
	account: null,
	busy: false,
	error: null,
	hydrate: async () => {
		const account = await currentAccount();
		set({ account, hydrated: true });
	},
	signIn: async () => {
		set({ busy: true, error: null });
		try {
			const account = await workosSignIn();
			set({ account, busy: false });
		} catch (cause) {
			set({ busy: false, error: message(cause) });
		}
	},
	signOut: async () => {
		await workosSignOut();
		resetRelayAccessToken();
		set({ account: null });
	},
	resetApp: async () => {
		set({ busy: true, error: null });
		try {
			await resetLocalMobileData();
			set({ account: null, busy: false, error: null });
		} catch (cause) {
			set({ busy: false, error: message(cause) });
			throw cause;
		}
	},
	deleteAccount: async () => {
		set({ busy: true, error: null });
		try {
			await deleteRelayAccount();
		} catch (cause) {
			set({ busy: false, error: message(cause) });
			throw cause;
		}
		try {
			await resetLocalMobileData();
			set({ account: null, busy: false, error: null });
		} catch (cause) {
			set({
				account: null,
				busy: false,
				error: `Account deleted. ${message(cause)}`,
			});
		}
	},
}));
