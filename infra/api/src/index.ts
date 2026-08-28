import { Effect, type Layer, ManagedRuntime } from "effect";
import {
	ingestE2bLifecycleEvent,
	normalizeE2bLifecycleEvent,
} from "./cloud-billing-e2b.ts";
import { maintainCloudBilling } from "./cloud-billing-outbox.ts";
import { CloudBillingStore } from "./cloud-billing-store.ts";
import {
	reconcileCloudBuild,
	reconcileCloudPool,
	reconcileCloudResources,
	reconcileCloudWorkspace,
	reconcileCloudWorkspaceStartup,
} from "./cloud-workspace-reconciler.ts";
import { type ApiContext, handleRequest } from "./handler.ts";
import { reconcileMachine, reconcileMachines } from "./machine-reconciler.ts";

export * from "./account-identity.ts";
export { API_SCOPES } from "./auth.ts";
export * from "./beta-access.ts";
export * from "./cloud-billing.ts";
export * from "./cloud-billing-outbox.ts";
export * from "./cloud-billing-provider.ts";
export * from "./cloud-billing-store.ts";
export * from "./cloud-billing-store-memory.ts";
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
 * Build a `fetch`-style handler bound to a api layer graph. The layer must
 * provide {@link ApiContext} (ApiConfiguration + WorkosVerifier + ApiStore).
 *
 * Tests wire `ApiStoreMemory` + `WorkosVerifierTest`; the Worker wires the
 * Postgres store + live WorkOS verifier (see worker.ts).
 */
export const makeApi = (
	layer: Layer.Layer<ApiContext>,
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
	readonly reconcileCloudPool: (accountId: string) => Promise<void>;
	readonly reconcileCloudWorkspace: (workspaceId: string) => Promise<void>;
	readonly reconcileCloudWorkspaceStartup: (
		workspaceId: string,
	) => Promise<void>;
	readonly maintainCloudBilling: (nowMs: number) => Promise<{
		readonly exported: number;
		readonly meterReconciled: number;
		readonly purgedRawEvents: number;
	}>;
	readonly hasFinalizedE2bBillingEvent: (
		eventId: string,
		providerExecutionId?: string,
	) => Promise<boolean>;
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
		reconcileCloudPool: (accountId) =>
			runtime.runPromise(reconcileCloudPool(accountId)),
		reconcileCloudWorkspace: (workspaceId) =>
			runtime.runPromise(reconcileCloudWorkspace(workspaceId)),
		reconcileCloudWorkspaceStartup: (workspaceId) =>
			runtime.runPromise(reconcileCloudWorkspaceStartup(workspaceId)),
		maintainCloudBilling: (nowMs) =>
			runtime.runPromise(maintainCloudBilling(nowMs)),
		hasFinalizedE2bBillingEvent: (eventId, providerExecutionId) =>
			runtime.runPromise(
				Effect.gen(function* () {
					return yield* (yield* CloudBillingStore).isProviderEventFinalized(
						"e2b",
						eventId,
						providerExecutionId,
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
