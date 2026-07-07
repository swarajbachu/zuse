import { Context, type Effect } from "effect";

import type { AuthFlowError } from "@zuse/wire";

/**
 * The host-shell seam for the OAuth deep-link flow — the auth analogue of
 * `FolderPicker`. `apps/server` stays free of any electron import (ADR 0007);
 * the Electron host (apps/desktop) supplies this, a headless server supplies a
 * loopback-HTTP variant, a future mobile shell supplies its own.
 *
 * - `redirectUri`: the OAuth redirect the host listens on (Electron: a
 *   localhost loopback served by the main process; mobile: a custom scheme).
 *   Must exactly match a redirect URI registered in the WorkOS dashboard.
 * - `open`: launch the system browser at the WorkOS authorization URL.
 * - `onCallbackUrl`: register the sink the host calls when the callback
 *   arrives. AuthService registers its `deliverCallback` here at layer-build
 *   time; the host buffers any URL that lands before registration and flushes
 *   it on register.
 */
export interface AuthShellShape {
  readonly redirectUri: string;
  readonly open: (url: string) => Effect.Effect<void, AuthFlowError>;
  readonly onCallbackUrl: (
    handler: (url: string) => void,
  ) => Effect.Effect<void>;
}

export class AuthShell extends Context.Tag("memoize/AuthShell")<
  AuthShell,
  AuthShellShape
>() {}
