import { type Layer, ManagedRuntime } from "effect";

import { handleRequest, type RelayContext } from "./handler.ts";
import { reconcileMachine, reconcileMachines } from "./machine-reconciler.ts";

export * from "./account-identity.ts";
export { RELAY_SCOPES } from "./auth.ts";
export * from "./config.ts";
export * from "./errors.ts";
export * from "./machine-config.ts";
export * from "./machine-offers.ts";
export * from "./machine-reconciler.ts";
export * from "./machine-store.ts";
export * from "./managed-tunnel.ts";
export * from "./push.ts";
export * from "./store.ts";
export * from "./workos.ts";

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
	readonly reconcile: (owner: string) => Promise<{
		readonly claimed: number;
		readonly processed: number;
	}>;
	readonly reconcileMachine: (
		machineId: string,
		owner: string,
	) => Promise<{
		readonly claimed: number;
		readonly processed: number;
	}>;
	readonly dispose: () => Promise<void>;
} => {
	const runtime = ManagedRuntime.make(layer);
	return {
		fetch: (request) => runtime.runPromise(handleRequest(request)),
		reconcile: (owner) => runtime.runPromise(reconcileMachines({ owner })),
		reconcileMachine: (machineId, owner) =>
			runtime.runPromise(reconcileMachine({ machineId, owner })),
		dispose: () => runtime.dispose(),
	};
};
