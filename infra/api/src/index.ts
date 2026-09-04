import { Effect, type Layer, ManagedRuntime } from "effect";
import { cloudBillingCapacity } from "./cloud-billing-capacity.ts";
import {
	ingestE2bLifecycleEvent,
	normalizeE2bLifecycleEvent,
} from "./cloud-billing-e2b.ts";
import { maintainCloudBilling } from "./cloud-billing-outbox.ts";
import { CloudBillingStore } from "./cloud-billing-store.ts";
import {
	MAILBOX_RUNTIME_STALL_TIMEOUT_MS,
	reconcileCloudBuild,
	reconcileCloudPool,
	reconcileCloudResources,
	reconcileCloudWorkspace,
	reconcileCloudWorkspaceStartup,
} from "./cloud-workspace-reconciler.ts";
import {
	type CloudMailboxLifecycleFence,
	CloudWorkspaceStore,
} from "./cloud-workspace-store.ts";
import { ApiConfiguration } from "./config.ts";
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
	readonly requestCloudMailboxWake: (
		workspaceId: string,
		accountId: string,
	) => Promise<"ready" | "blocked" | "destroyed">;
	readonly completeCloudMailboxDrain: (
		workspaceId: string,
		accountId: string,
		runtimeGeneration: number,
		wakeRevision: number,
	) => Promise<boolean>;
	readonly recordCloudMailboxRuntimeProgress: (
		workspaceId: string,
		accountId: string,
		runtimeGeneration: number,
		wakeRevision: number,
		mailboxRevision: number,
		fenceRequired: boolean,
	) => Promise<boolean>;
	readonly listPendingCloudMailboxLifecycles: (
		limit: number,
	) => Promise<ReadonlyArray<CloudMailboxLifecycleFence>>;
	readonly acknowledgeCloudMailboxLifecycle: (
		lifecycle: CloudMailboxLifecycleFence,
		nowMs: number,
	) => Promise<boolean>;
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
		requestCloudMailboxWake: (workspaceId, accountId) =>
			runtime.runPromise(
				Effect.gen(function* () {
					const store = yield* CloudWorkspaceStore;
					const workspace = yield* store.getWorkspace(workspaceId);
					if (workspace === null || workspace.accountId !== accountId)
						return "destroyed" as const;
					if (
						workspace.state === "archived" ||
						workspace.state === "archiving" ||
						workspace.state === "deleted" ||
						workspace.state === "deleting" ||
						workspace.desiredState === "archived" ||
						workspace.desiredState === "deleted"
					)
						return "destroyed" as const;
					const nowMs = Date.now();
					const configuration = yield* ApiConfiguration;
					const billingCapacity = yield* cloudBillingCapacity(accountId, nowMs);
					const updated = yield* store.requestMailboxWake(
						workspaceId,
						accountId,
						nowMs,
						nowMs + configuration.cloudWorkspaceIdleTimeoutMs,
					);
					return updated?.desiredState !== "ready" ||
						billingCapacity !== "available"
						? ("blocked" as const)
						: ("ready" as const);
				}),
			),
		completeCloudMailboxDrain: (
			workspaceId,
			accountId,
			runtimeGeneration,
			wakeRevision,
		) =>
			runtime.runPromise(
				Effect.gen(function* () {
					const store = yield* CloudWorkspaceStore;
					const configuration = yield* ApiConfiguration;
					const nowMs = Date.now();
					return yield* store.completeMailboxDrain(
						workspaceId,
						accountId,
						runtimeGeneration,
						wakeRevision,
						nowMs,
						nowMs + configuration.cloudWorkspaceIdleTimeoutMs,
					);
				}),
			),
		recordCloudMailboxRuntimeProgress: (
			workspaceId,
			accountId,
			runtimeGeneration,
			wakeRevision,
			mailboxRevision,
			fenceRequired,
		) =>
			runtime.runPromise(
				Effect.gen(function* () {
					const store = yield* CloudWorkspaceStore;
					const nowMs = Date.now();
					return yield* store.recordMailboxRuntimeProgress(
						workspaceId,
						accountId,
						runtimeGeneration,
						wakeRevision,
						mailboxRevision,
						fenceRequired,
						nowMs,
						nowMs + MAILBOX_RUNTIME_STALL_TIMEOUT_MS,
					);
				}),
			),
		listPendingCloudMailboxLifecycles: (limit) =>
			runtime.runPromise(
				Effect.gen(function* () {
					return yield* (yield* CloudWorkspaceStore).listPendingMailboxLifecycles(
						limit,
					);
				}),
			),
		acknowledgeCloudMailboxLifecycle: (lifecycle, nowMs) =>
			runtime.runPromise(
				Effect.gen(function* () {
					return yield* (yield* CloudWorkspaceStore).acknowledgeMailboxLifecycle(
						lifecycle,
						nowMs,
					);
				}),
			),
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
