import type { QueueMessage } from "@zuse/slack/types";
import { isSlackWebhookTarget } from "@zuse/slack/webhook-target";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ApiInternalWebhooks } from "./api-internal-webhooks.ts";
import {
	type ApiCommandNudgeTarget,
	deliverPendingApiWebhooks,
	sweepApiCommands,
} from "./api-webhook-dispatch.ts";
import { cloudBillingCapacity } from "./cloud-billing-capacity.ts";
import { maintainCloudBilling } from "./cloud-billing-outbox.ts";
import { CloudBillingStore } from "./cloud-billing-store.ts";
import { findBillingUsageSourceModule } from "./cloud-billing-usage-source-config.ts";
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
import { makeSlackModule, type SlackOptions } from "./slack/module.ts";

export * from "./account-identity.ts";
export * from "./api-webhook-dispatch.ts";
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
	options?: {
		readonly slack?: SlackOptions;
		/** Retain the receiver's identity while disabled so pending deliveries retry. */
		readonly slackPublicOrigin?: string;
	},
): {
	readonly fetch: (request: Request) => Promise<Response>;
	readonly consumeSlackJobs: (batch: {
		readonly messages: ReadonlyArray<QueueMessage>;
	}) => Promise<void>;
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
	readonly hasFinalizedProviderBillingEvent: (
		provider: string,
		eventId: string,
		providerExecutionId?: string,
	) => Promise<boolean>;
	readonly ingestProviderBillingEvents: (
		provider: string,
		events: ReadonlyArray<unknown>,
		nowMs: number,
	) => Promise<number>;
	readonly deliverApiWebhooks: () => Promise<number>;
	readonly sweepApiCommands: () => Promise<
		ReadonlyArray<ApiCommandNudgeTarget>
	>;
	readonly dispose: () => Promise<void>;
} => {
	const slackOptions = options?.slack;
	const slackPublicOrigin =
		slackOptions?.publicOrigin ?? options?.slackPublicOrigin;
	const internalWebhooks = Layer.succeed(ApiInternalWebhooks, {
		accepts: (url) =>
			slackPublicOrigin !== undefined &&
			isSlackWebhookTarget(url, slackPublicOrigin),
		receive: async (request): Promise<Response> =>
			slackOptions
				? (await slack()).fetch(request)
				: new Response("Slack integration is not enabled.", { status: 503 }),
	});
	const runtime = ManagedRuntime.make(Layer.merge(layer, internalWebhooks));
	const slack = () => {
		if (!options?.slack) throw new Error("slack_not_configured");
		return runtime.runPromise(makeSlackModule(options.slack));
	};
	return {
		fetch: async (request) => {
			const path = new URL(request.url).pathname;
			if (path === "/slack" || path.startsWith("/slack/")) {
				if (!options?.slack)
					return new Response("Slack integration is not enabled.", {
						status: 503,
					});
				try {
					return await (await slack()).fetch(request);
				} catch {
					console.error("[slack-app] integration initialization failed");
					return new Response("Slack integration is unavailable.", {
						status: 503,
					});
				}
			}
			return runtime.runPromise(handleRequest(request));
		},
		consumeSlackJobs: async (batch) => (await slack()).queue(batch),
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
		deliverApiWebhooks: () => runtime.runPromise(deliverPendingApiWebhooks),
		sweepApiCommands: () => runtime.runPromise(sweepApiCommands),
		hasFinalizedProviderBillingEvent: (
			provider,
			eventId,
			providerExecutionId,
		) =>
			runtime.runPromise(
				Effect.gen(function* () {
					return yield* (yield* CloudBillingStore).isProviderEventFinalized(
						provider,
						eventId,
						providerExecutionId,
					);
				}),
			),
		ingestProviderBillingEvents: (provider, events, nowMs) => {
			const usageSource = findBillingUsageSourceModule(provider);
			if (usageSource === undefined)
				return Promise.reject(
					new Error(`Unknown billing usage source: ${provider}`),
				);
			return runtime.runPromise(usageSource.ingestPolled(events, nowMs));
		},
		dispose: () => runtime.dispose(),
	};
};
