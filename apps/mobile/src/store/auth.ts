import { Effect } from "effect";
import { create } from "zustand";
import { clearDeviceKey } from "../auth/dpop.ts";
import {
	currentAccount,
	type WorkosAccount,
	signIn as workosSignIn,
	signOut as workosSignOut,
} from "../auth/workos.ts";
import { clearPushRegistration } from "../notifications/push.ts";
import { clearOfflineCache } from "../offline/cache.ts";
import {
	deleteAccount as deleteRelayAccount,
	resetRelayAccessToken,
} from "../rpc/relay-client.ts";
import { useConnectionsStore } from "./connections.ts";
import { useMobileMessagesStore } from "./messages.ts";
import { useOutboxStore } from "./outbox.ts";
import { usePermissionsStore } from "./permissions.ts";
import { useSessionsStore } from "./sessions.ts";

type AuthState = {
	hydrated: boolean;
	account: WorkosAccount | null;
	busy: boolean;
	error: string | null;
	hydrate: () => Promise<void>;
	signIn: () => Promise<void>;
	signOut: () => Promise<void>;
	deleteAccount: () => Promise<void>;
};

const message = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

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
	deleteAccount: async () => {
		set({ busy: true, error: null });
		try {
			await deleteRelayAccount();
		} catch (cause) {
			set({ busy: false, error: message(cause) });
			throw cause;
		}
		const cleanup = await Promise.allSettled([
			workosSignOut(),
			clearDeviceKey(),
			clearPushRegistration(),
			Effect.runPromise(clearOfflineCache()),
			useConnectionsStore.getState().clear(),
		]);
		resetRelayAccessToken();
		useMobileMessagesStore.setState({
			messagesBySession: {},
			reconnectingBySession: {},
			errorBySession: {},
		});
		useOutboxStore.setState({
			queuedBySession: {},
			sendingBySession: {},
			errorBySession: {},
		});
		usePermissionsStore.setState({ pendingBySession: {} });
		useSessionsStore.setState({
			bundlesByConnection: {},
			statusBySession: {},
			errorByConnection: {},
			loadingByConnection: {},
		});
		const localCleanupFailed = cleanup.some(
			(result) => result.status === "rejected",
		);
		set({
			account: null,
			busy: false,
			error: localCleanupFailed
				? "Account deleted. Some local files could not be cleared and will be retried by iOS."
				: null,
		});
	},
}));
