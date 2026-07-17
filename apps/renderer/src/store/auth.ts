import { Effect, Fiber, Schedule, Stream } from "effect";
import { createAtomStore as create } from "../state/atom-store.ts";

import type { AuthState } from "@zuse/contracts";

import { toastManager } from "../components/ui/toast.tsx";
import { getRpcClient } from "../lib/rpc-client.ts";
import {
  readStorageWithLegacy,
  removeStorageKeys,
} from "../lib/storage-keys.ts";

/**
 * WorkOS auth state mirror. Subscribes once to the server's `auth.sessionChanges`
 * broadcast (sign-in completes inside the blocking `auth.signIn` call, but a
 * sign-out or background refresh can also fire), and cold-loads via
 * `auth.getSession`. Modeled on `store/permissions.ts`'s self-healing stream.
 *
 * `state === null` means "still loading". Auth is fully OPTIONAL — there's no
 * gate; sign-in is reachable from the sidebar, onboarding, and settings.
 *
 * `displayName` is a local, cosmetic override for how the user's name shows in
 * the app. We can't rename the WorkOS profile from a public PKCE client (that
 * needs the API secret), so this is a renderer-only alias persisted to
 * localStorage.
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
    // Private mode / disabled storage — the alias just won't persist.
  }
};

const SIGNED_OUT: AuthState = { _tag: "SignedOut" };
const HYDRATE_RETRY_MS = 1_500;

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
  /** null until the first getSession / stream emit resolves. */
  readonly state: AuthState | null;
  readonly signingIn: boolean;
  readonly error: string | null;
  /** Local cosmetic name override (empty = use the WorkOS profile name). */
  readonly displayName: string;
  readonly start: () => void;
  readonly hydrate: () => Promise<void>;
  readonly signIn: () => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly setDisplayName: (value: string) => void;
};

let streamFiber: Fiber.Fiber<unknown, unknown> | null = null;
// Real double-subscribe guard — `streamFiber` is only a handle (see the same
// note in store/permissions.ts).
let started = false;

export const useAuthStore = create<AuthStore>((set, get) => ({
  state: null,
  signingIn: false,
  error: null,
  displayName: readDisplayName(),
  start: () => {
    if (started) return;
    started = true;
    const subscribeOnce = Effect.tryPromise(() => getRpcClient()).pipe(
      Effect.flatMap((client) =>
        Stream.runForEach(client["auth.sessionChanges"]({}), (next) =>
          Effect.sync(() => set({ state: next })),
        ),
      ),
    );
    // Self-healing: re-establish after any completion/error with bounded
    // backoff so a server restart / dev HMR doesn't kill live delivery.
    const program = subscribeOnce.pipe(
      Effect.catch(() => Effect.void),
      Effect.repeat(Schedule.spaced("2 seconds")),
      Effect.ensuring(
        Effect.sync(() => {
          streamFiber = null;
          started = false;
        }),
      ),
    );
    streamFiber = Effect.runFork(program);
  },
  hydrate: async () => {
    try {
      const client = await getRpcClient();
      const next = await Effect.runPromise(client["auth.getSession"]({}));
      set({ state: next });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, HYDRATE_RETRY_MS));
      try {
        const client = await getRpcClient();
        const next = await Effect.runPromise(client["auth.getSession"]({}));
        set({ state: next });
      } catch {
        // Bridge not up yet / transient. Keep the previous/loading state; the
        // retrying sessionChanges stream will publish the definitive state.
        set((prev) => ({ state: prev.state }));
      }
    }
  },
  signIn: async () => {
    if (get().signingIn) return;
    set({ signingIn: true, error: null });
    toastManager.add({
      type: "info",
      title: "Opening browser sign-in",
      description: "Complete WorkOS sign-in in your browser.",
    });
    try {
      const client = await getRpcClient();
      // Match the Effect to a result object so a user-cancel (silent) and a
      // real failure (shown) are distinguishable without a throw.
      const result = await Effect.runPromise(
        client["auth.signIn"]({}).pipe(
          Effect.match({
            onFailure: (err) => ({ ok: false as const, err }),
            onSuccess: (next) => ({ ok: true as const, next }),
          }),
        ),
      );
      if (result.ok) {
        set({ state: result.next, signingIn: false, error: null });
        return;
      }
      const message = signInFailureMessage(result.err);
      set({
        signingIn: false,
        error: message,
      });
      toastManager.add({
        type: "error",
        title: "Sign-in failed",
        description: message,
      });
    } catch (err) {
      const message = signInFailureMessage(err);
      set({
        signingIn: false,
        error: message,
      });
      toastManager.add({
        type: "error",
        title: "Sign-in failed",
        description: message,
      });
    }
  },
  signOut: async () => {
    // Optimistic — the server also broadcasts SignedOut.
    set({ state: SIGNED_OUT });
    try {
      const client = await getRpcClient();
      await Effect.runPromise(client["auth.signOut"]({}));
    } catch {
      // A failed sign-out leaves the keychain entry; next getSession repairs.
    }
  },
  setDisplayName: (value) => {
    writeDisplayName(value);
    set({ displayName: value });
  },
}));
