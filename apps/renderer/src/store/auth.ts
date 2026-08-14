import { type AuthState, CommandId, EnvironmentId } from "@zuse/contracts";
import { toastManager } from "../components/ui/toast.tsx";
import { environmentAuthResourceKey } from "../lib/auth-client-bus.ts";
import { LOCAL_ENVIRONMENT_KEY } from "../lib/rpc-client.ts";
import { getRendererClientBus } from "../lib/session-timeline-client-bus.ts";
import {
	readStorageWithLegacy,
	removeStorageKeys,
} from "../lib/storage-keys.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { useEnvironmentCatalogStore } from "./environment-catalog.ts";

/**
 * Auth actions and renderer-only display-name preference. Canonical server auth
 * state and its stream lifecycle live in the environment-auth ClientBus cell.
 */

const DISPLAY_NAME_KEY = "zuse.auth.displayName";
const LEGACY_DISPLAY_NAME_KEYS = ["memoize.auth.displayName"] as const;

const readDisplayName = (): string => {
	try {
		return (
			readStorageWithLegacy(
				window.localStorage,
				DISPLAY_NAME_KEY,
				LEGACY_DISPLAY_NAME_KEYS,
			) ?? ""
		);
	} catch {
		return "";
	}
};

const writeDisplayName = (value: string): void => {
	try {
		if (value.trim() === "") {
			removeStorageKeys(
				window.localStorage,
				DISPLAY_NAME_KEY,
				LEGACY_DISPLAY_NAME_KEYS,
			);
		} else window.localStorage.setItem(DISPLAY_NAME_KEY, value);
	} catch {
		// Private mode / disabled storage — the alias simply does not persist.
	}
};

const SIGNED_OUT = { _tag: "SignedOut" } as const;

const signInFailureMessage = (err: unknown): string =>
	typeof err === "object" &&
	err !== null &&
	"_tag" in err &&
	err._tag === "AuthCancelledError"
		? "No sign-in callback was received. Check the WorkOS client ID and redirect URI, then try again."
		: typeof err === "object" &&
				err !== null &&
				"reason" in err &&
				typeof err.reason === "string"
			? err.reason
			: err instanceof Error
				? err.message
				: "Sign-in failed. Please try again.";

type AuthStore = {
	readonly signingIn: boolean;
	readonly error: string | null;
	/** Local cosmetic name override (empty = use the WorkOS profile name). */
	readonly displayName: string;
	readonly signIn: () => Promise<void>;
	readonly signOut: () => Promise<void>;
	readonly setDisplayName: (value: string) => void;
};

const activeAuthResource = () => {
	const environmentId = EnvironmentId.make(
		useEnvironmentCatalogStore
			.getState()
			.entries.find((entry) => entry.connectionKind === "local")
			?.environmentId ?? LOCAL_ENVIRONMENT_KEY,
	);
	return { environmentId, key: environmentAuthResourceKey(environmentId) };
};

export const useAuthStore = create<AuthStore>((set, get) => ({
	signingIn: false,
	error: null,
	displayName: readDisplayName(),
	signIn: async () => {
		if (get().signingIn) return;
		set({ signingIn: true, error: null });
		toastManager.add({
			type: "info",
			title: "Opening browser sign-in",
			description: "Complete WorkOS sign-in in your browser.",
		});
		try {
			const { environmentId, key } = activeAuthResource();
			const bus = getRendererClientBus();
			const receipt = await bus.dispatch<AuthState>({
				kind: "auth.signIn",
				commandId: CommandId.make(`auth-sign-in:${crypto.randomUUID()}`),
				environmentId,
				resource: key,
				payload: {},
				retry: "never",
				createdAt: Date.now(),
			});
			bus.overlay(key, { update: () => ({ state: receipt.result }) });
			set({ signingIn: false, error: null });
		} catch (err) {
			const message = signInFailureMessage(err);
			set({ signingIn: false, error: message });
			toastManager.add({
				type: "error",
				title: "Sign-in failed",
				description: message,
			});
		}
	},
	signOut: async () => {
		const { environmentId, key } = activeAuthResource();
		const bus = getRendererClientBus();
		const previous = bus.snapshot(key)?.data ?? undefined;
		bus.overlay(key, { update: () => ({ state: SIGNED_OUT }) });
		try {
			await bus.dispatch({
				kind: "auth.signOut",
				commandId: CommandId.make(`auth-sign-out:${crypto.randomUUID()}`),
				environmentId,
				resource: key,
				payload: {},
				retry: "never",
				createdAt: Date.now(),
			});
		} catch {
			if (previous !== undefined) {
				bus.overlay(key, { update: () => previous });
			}
		}
	},
	setDisplayName: (value) => {
		writeDisplayName(value);
		set({ displayName: value });
	},
}));
