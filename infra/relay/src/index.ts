import { type Layer, ManagedRuntime } from "effect";
import { backfillCloudChatEncryption } from "./cloud-chat-backfill.ts";
import {
	reconcileCloudBuild,
	reconcileCloudResources,
	reconcileCloudWorkspace,
} from "./cloud-workspace-reconciler.ts";
import { handleRequest, type RelayContext } from "./handler.ts";
import { reconcileMachine, reconcileMachines } from "./machine-reconciler.ts";

export * from "./account-identity.ts";
export { RELAY_SCOPES } from "./auth.ts";
export * from "./cloud-chat-backfill.ts";
export * from "./cloud-chat-cipher.ts";
export * from "./cloud-credential-vault.ts";
export * from "./cloud-workspace-store.ts";
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
	readonly reconcileCloud: () => Promise<{
		readonly builds: number;
		readonly workspaces: number;
	}>;
	readonly reconcileCloudBuild: (buildId: string) => Promise<void>;
	readonly reconcileCloudWorkspace: (workspaceId: string) => Promise<void>;
	readonly backfillCloudChatEncryption: () => Promise<{
		readonly workspaces: number;
		readonly records: number;
	}>;
	readonly dispose: () => Promise<void>;
} => {
	const runtime = ManagedRuntime.make(layer);
	return {
		fetch: (request) => runtime.runPromise(handleRequest(request)),
		reconcile: (owner) => runtime.runPromise(reconcileMachines({ owner })),
		reconcileMachine: (machineId, owner) =>
			runtime.runPromise(reconcileMachine({ machineId, owner })),
		reconcileCloud: () => runtime.runPromise(reconcileCloudResources()),
		reconcileCloudBuild: (buildId) =>
			runtime.runPromise(reconcileCloudBuild(buildId)),
		reconcileCloudWorkspace: (workspaceId) =>
			runtime.runPromise(reconcileCloudWorkspace(workspaceId)),
		backfillCloudChatEncryption: () =>
			runtime.runPromise(backfillCloudChatEncryption()),
		dispose: () => runtime.dispose(),
	};
};
