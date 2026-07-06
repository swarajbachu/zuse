import { create } from "zustand";

import {
  currentAccount,
  signIn as workosSignIn,
  signOut as workosSignOut,
  type WorkosAccount,
} from "../auth/workos.ts";
import { resetRelayAccessToken } from "../rpc/relay-client.ts";

type AuthState = {
  hydrated: boolean;
  account: WorkosAccount | null;
  busy: boolean;
  error: string | null;
  hydrate: () => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
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
}));
