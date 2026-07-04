import type { AuthUser } from "@zuse/wire";

import { useAuthStore } from "../store/auth.ts";

/**
 * Thin selector over the auth store. `isLoading` is true until the first
 * getSession / stream emit resolves. `name` is the effective display name —
 * the local override if set, else the WorkOS profile name, else the email.
 */
export interface UseAuth {
  readonly user: AuthUser | null;
  readonly isSignedIn: boolean;
  readonly isLoading: boolean;
  readonly signingIn: boolean;
  readonly error: string | null;
  /** Effective display name (override → WorkOS name → email). */
  readonly name: string;
  /** Raw local override (empty if unset). */
  readonly displayName: string;
  readonly setDisplayName: (value: string) => void;
  readonly signIn: () => Promise<void>;
  readonly signOut: () => Promise<void>;
}

const profileName = (user: AuthUser | null): string => {
  if (user === null) return "";
  const full = [user.firstName, user.lastName]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  return full || user.email;
};

export function useAuth(): UseAuth {
  const state = useAuthStore((s) => s.state);
  const signingIn = useAuthStore((s) => s.signingIn);
  const error = useAuthStore((s) => s.error);
  const displayName = useAuthStore((s) => s.displayName);
  const setDisplayName = useAuthStore((s) => s.setDisplayName);
  const signIn = useAuthStore((s) => s.signIn);
  const signOut = useAuthStore((s) => s.signOut);

  const user = state?._tag === "SignedIn" ? state.session.user : null;

  return {
    user,
    isSignedIn: state?._tag === "SignedIn",
    isLoading: state === null,
    signingIn,
    error,
    name: displayName.trim() || profileName(user),
    displayName,
    setDisplayName,
    signIn,
    signOut,
  };
}
