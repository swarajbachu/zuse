import { Rpc } from "effect/unstable/rpc";
import { Schema } from "effect";

/**
 * WorkOS AuthKit identity — the first user-account primitive in Zuse.
 *
 * The desktop app authenticates the user against WorkOS via a PKCE OAuth flow
 * (public client, no secret) that round-trips through the system browser and a
 * `zuse://auth/callback` deep link. The access/refresh tokens never cross
 * this wire — they live only in the OS keychain on the server side, mirroring
 * the `apiKey:` / `browserCred:` discipline. Only the non-secret profile and an
 * expiry timestamp are renderer-visible.
 *
 * This contract is transport-agnostic on purpose: a future mobile shell or
 * headless WS server reuses these exact schemas (see ADR 0007).
 */

/** Non-secret identity surfaced to the renderer for display. */
export class AuthUser extends Schema.Class<AuthUser>("AuthUser")({
  id: Schema.String,
  email: Schema.String,
  firstName: Schema.NullOr(Schema.String),
  lastName: Schema.NullOr(Schema.String),
  profilePictureUrl: Schema.NullOr(Schema.String),
}) {}

/**
 * A live session. `expiresAt` is the access token's expiry (epoch ms) — the
 * renderer never sees the token itself, but the timestamp lets the UI reason
 * about staleness if it ever wants to. `organizationId` is null for personal
 * (non-org) sign-ins.
 */
export class AuthSession extends Schema.Class<AuthSession>("AuthSession")({
  user: AuthUser,
  organizationId: Schema.NullOr(Schema.String),
  expiresAt: Schema.Number,
}) {}

/**
 * The complete renderer-visible auth state. A tagged union so the renderer
 * switches on `_tag` rather than null-checking a session. `auth.getSession`
 * returns this once on cold load; `auth.sessionChanges` re-emits it on every
 * sign-in / sign-out / refresh.
 */
export const AuthState = Schema.Union([
  Schema.TaggedStruct("SignedOut", {}),
  Schema.TaggedStruct("SignedIn", { session: AuthSession }),
]);
export type AuthState = typeof AuthState.Type;

/** The OAuth flow failed (config missing, network, token exchange, bad callback). */
export class AuthFlowError extends Schema.TaggedErrorClass<AuthFlowError>()(
  "AuthFlowError",
  { reason: Schema.String },
) {}

/** The user closed the browser / never completed sign-in before the timeout. */
export class AuthCancelledError extends Schema.TaggedErrorClass<AuthCancelledError>()(
  "AuthCancelledError",
  {},
) {}

// ---------------------------------------------------------------------------
// RPCs
// ---------------------------------------------------------------------------

/**
 * Cold-load the current session. Runs a refresh-on-demand if the stored access
 * token is near expiry. Never fails — a missing/invalid session resolves to
 * `SignedOut` so the renderer can always render a definite state.
 */
export const AuthGetSessionRpc = Rpc.make("auth.getSession", {
  payload: Schema.Struct({}),
  success: AuthState,
});

/**
 * Begin sign-in. The server opens the system browser to WorkOS and BLOCKS this
 * request until the `zuse://auth/callback` deep link resolves the flow (or
 * a 5-minute timeout fires → `AuthCancelledError`). Resolves to the new
 * `SignedIn` state.
 */
export const AuthSignInRpc = Rpc.make("auth.signIn", {
  payload: Schema.Struct({}),
  success: AuthState,
  error: Schema.Union([AuthFlowError, AuthCancelledError]),
});

/** Clear the stored session and broadcast `SignedOut`. */
export const AuthSignOutRpc = Rpc.make("auth.signOut", {
  payload: Schema.Struct({}),
  success: Schema.Void,
});

/**
 * Live broadcast of auth state. The renderer subscribes once on boot (like
 * `permission.requests`) so a sign-in completed in the blocking `auth.signIn`
 * call, a sign-out, or a background refresh all propagate to every view.
 */
export const AuthSessionChangesRpc = Rpc.make("auth.sessionChanges", {
  payload: Schema.Struct({}),
  success: AuthState,
  stream: true,
});
