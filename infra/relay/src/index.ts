import { Effect, type Layer, ManagedRuntime } from "effect";
import {
	ingestE2bLifecycleEvent,
	normalizeE2bLifecycleEvent,
} from "./cloud-billing-e2b.ts";
import { maintainCloudBilling } from "./cloud-billing-outbox.ts";
import { CloudBillingStore } from "./cloud-billing-store.ts";
import {
	reconcileCloudBuild,
	reconcileCloudResources,
	reconcileCloudWorkspace,
} from "./cloud-workspace-reconciler.ts";
import { handleRequest, type RelayContext } from "./handler.ts";
import { reconcileMachine, reconcileMachines } from "./machine-reconciler.ts";

export * from "./account-identity.ts";
export { RELAY_SCOPES } from "./auth.ts";
export * from "./cloud-billing.ts";
export * from "./cloud-billing-outbox.ts";
export * from "./cloud-billing-store.ts";
export * from "./cloud-billing-store-memory.ts";
export * from "./cloud-credential-vault.ts";
export * from "./cloud-workspace-launch-intent.ts";
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
	readonly maintainCloudBilling: (nowMs: number) => Promise<{
		readonly exported: number;
		readonly meterReconciled: number;
		readonly purgedRawEvents: number;
	}>;
	readonly hasE2bBillingEvent: (eventId: string) => Promise<boolean>;
	readonly ingestE2bBillingEvents: (
		events: ReadonlyArray<unknown>,
		nowMs: number,
	) => Promise<number>;
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
		maintainCloudBilling: (nowMs) =>
			runtime.runPromise(maintainCloudBilling(nowMs)),
		hasE2bBillingEvent: (eventId) =>
			runtime.runPromise(
				Effect.gen(function* () {
					return yield* (yield* CloudBillingStore).hasProviderEvent(
						"e2b",
						eventId,
					);
				}),
			),
		ingestE2bBillingEvents: (events, nowMs) =>
			runtime.runPromise(
				Effect.gen(function* () {
					let metered = 0;
					for (const payload of events) {
						const event = normalizeE2bLifecycleEvent(payload);
						if (event === null) continue;
						const result = yield* ingestE2bLifecycleEvent({
							event,
							rawPayload: payload,
							source: "poll",
							deliveryId: `poll:${event.id}`,
							nowMs,
						});
						if (result.metered) metered++;
					}
					return metered;
				}),
			),
		dispose: () => runtime.dispose(),
	};
};
