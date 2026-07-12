import { Context, type Effect } from "effect";

import type {
  ConvexAuthError,
  ConvexAuthRequiredError,
  ConvexConnection,
} from "@zuse/contracts";

/**
 * The user's Convex platform-OAuth connection (team scope). Owns the PKCE
 * flow against `dashboard.convex.dev/oauth/authorize/team` and the keychain
 * token bundle (`convex:oauth`). The access token never crosses the wire —
 * only the redacted `ConvexConnection` does. See ADR 0022.
 */
export interface ConvexAuthServiceShape {
  /** Redacted connection state for the renderer; null when disconnected. */
  readonly status: () => Effect.Effect<ConvexConnection | null>;
  /** Open the browser consent flow and block until the callback resolves. */
  readonly connect: () => Effect.Effect<ConvexConnection, ConvexAuthError>;
  /** Drop the keychain bundle. */
  readonly disconnect: () => Effect.Effect<void>;
  /**
   * Server-internal: the raw application token for Management API calls.
   * Convex tokens have no documented refresh — a 401 downstream means the
   * user reconnects (`ConvexAuthRequiredError` surfaces the CTA).
   */
  readonly getToken: () => Effect.Effect<string, ConvexAuthRequiredError>;
}

export class ConvexAuthService extends Context.Service<
  ConvexAuthService,
  ConvexAuthServiceShape
>()("memoize/ConvexAuthService") {}
