import { Context, type Effect, type Stream } from "effect";

import type {
  AuthCancelledError,
  AuthFlowError,
  AuthState,
} from "@zuse/contracts";

import type { AuthTokenError } from "../errors.ts";

/**
 * WorkOS-backed identity for the app. Owns the PKCE flow, the keychain token
 * bundle, and the broadcast of auth state. Tokens never cross the wire — only
 * `getAccessToken` (server-internal) hands out the raw access token, for a
 * future cloud/mobile API caller to attach as a bearer.
 */
export interface AuthServiceShape {
  /** Cold load; refresh-on-demand; never fails (folds to SignedOut). */
  readonly getSession: () => Effect.Effect<AuthState>;
  /** Open the browser and block until the deep link resolves the flow. */
  readonly signIn: () => Effect.Effect<
    AuthState,
    AuthFlowError | AuthCancelledError
  >;
  /** Clear the keychain bundle and broadcast SignedOut. */
  readonly signOut: () => Effect.Effect<void>;
  /** Live auth-state broadcast (sign-in / sign-out / refresh). */
  readonly sessionChanges: () => Stream.Stream<AuthState>;
  /**
   * Server-internal: a fresh access token (refresh-on-demand), for outbound
   * calls to a future memoize cloud API. NEVER exposed over RPC — keeping the
   * token off the wire is the whole point of the keychain bundle.
   */
  readonly getAccessToken: () => Effect.Effect<string, AuthTokenError>;
}

export class AuthService extends Context.Service<
  AuthService,
  AuthServiceShape
>()("memoize/AuthService") {}
