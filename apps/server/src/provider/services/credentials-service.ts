import { Context, type Effect } from "effect";

import type { ProviderId } from "@zuse/wire";

import type { CredentialsError } from "../errors.ts";

/**
 * OS-keychain-backed credential store keyed by `providerId`. Used by the SDK
 * adapters to retrieve API keys without ever surfacing them to renderer code.
 * Set via the `agent.setCredential` RPC; never returned over the wire — only
 * `listConfigured()` is renderer-visible, surfaced as the `hasApiKey` flag
 * on `AgentAvailability`. CLI-login credentials (the primary auth path)
 * never touch this service.
 */
export interface CredentialsServiceShape {
  readonly get: (
    providerId: ProviderId,
  ) => Effect.Effect<string | null, CredentialsError>;
  readonly set: (
    providerId: ProviderId,
    apiKey: string,
  ) => Effect.Effect<void, CredentialsError>;
  readonly remove: (
    providerId: ProviderId,
  ) => Effect.Effect<void, CredentialsError>;
  readonly listConfigured: () => Effect.Effect<
    ReadonlyArray<ProviderId>,
    CredentialsError
  >;

  /**
   * In-app agent browser credentials — DUMMY/TEST logins only. Keyed by web
   * origin, namespaced `browserCred:<origin>` in the same keychain. Stored as
   * `{ username, password }`. `listBrowser` deliberately drops the password so
   * the settings UI only ever sees origin + username.
   */
  readonly setBrowser: (
    origin: string,
    username: string,
    password: string,
  ) => Effect.Effect<void, CredentialsError>;
  readonly getBrowser: (
    origin: string,
  ) => Effect.Effect<{ username: string; password: string } | null, CredentialsError>;
  readonly removeBrowser: (
    origin: string,
  ) => Effect.Effect<void, CredentialsError>;
  readonly listBrowser: () => Effect.Effect<
    ReadonlyArray<{ origin: string; username: string }>,
    CredentialsError
  >;

  /**
   * WorkOS AuthKit session bundle (access + refresh tokens, expiry, and the
   * non-secret profile) serialized as JSON under a single `workos:session`
   * keychain account. Lives alongside `apiKey:` / `browserCred:` in the same
   * `memoize` service. The tokens NEVER leave the server — only the AuthService
   * reads this; the renderer sees a redacted `AuthState` over the wire.
   */
  readonly getWorkosSession: () => Effect.Effect<string | null, CredentialsError>;
  readonly setWorkosSession: (
    bundleJson: string,
  ) => Effect.Effect<void, CredentialsError>;
  readonly removeWorkosSession: () => Effect.Effect<void, CredentialsError>;
}

export class CredentialsService extends Context.Service<CredentialsService, CredentialsServiceShape>()(
  "memoize/CredentialsService",
) {}
