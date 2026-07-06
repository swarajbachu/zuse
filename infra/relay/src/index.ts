import { Layer, ManagedRuntime } from "effect";

import { handleRequest, type RelayContext } from "./handler.ts";

export * from "./config.ts";
export * from "./errors.ts";
export * from "./store.ts";
export * from "./workos.ts";
export { RELAY_SCOPES } from "./auth.ts";

/**
 * Build a `fetch`-style handler bound to a relay layer graph. The layer must
 * provide {@link RelayContext} (RelayConfiguration + WorkosVerifier + RelayStore).
 *
 * Tests wire `RelayStoreMemory` + `WorkosVerifierTest`; the Worker wires the
 * Postgres store + live WorkOS verifier (see worker.ts).
 */
export const makeRelay = (
  layer: Layer.Layer<RelayContext>,
): {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly dispose: () => Promise<void>;
} => {
  const runtime = ManagedRuntime.make(layer);
  return {
    fetch: (request) => runtime.runPromise(handleRequest(request)),
    dispose: () => runtime.dispose(),
  };
};
