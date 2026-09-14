import type { SandboxProviders } from "@zuse/sandbox-providers";
import type { Effect } from "effect";
import type { CloudBillingStore } from "./cloud-billing-store.ts";
import type { CloudWorkspaceStore } from "./cloud-workspace-store.ts";
import type { ApiConfiguration } from "./config.ts";
import type { ApiError } from "./errors.ts";
import type { MachineStore } from "./machine-store.ts";

// Per-provider billing usage ingestion seam. Each sandbox provider that bills
// through the api registers one module: the webhook path
// `/v1/cloud/billing/webhook/{provider}` dispatches to `ingestWebhook`, the
// scheduled recovery pass calls `poll`, and polled payloads flow through
// `ingestPolled`. This is the billing sibling of `SandboxProviderModule`.

export type BillingUsageSourceEnvironment = object;

export interface BillingUsageRecovery {
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
}

export type BillingUsageSourceContext =
	| CloudBillingStore
	| CloudWorkspaceStore
	| MachineStore
	| ApiConfiguration
	| SandboxProviders;

export interface BillingUsageSourceModule {
	readonly provider: string;
	readonly ingestWebhook: (input: {
		readonly request: Request;
		readonly nowMs: number;
	}) => Effect.Effect<Response, ApiError, BillingUsageSourceContext>;
	readonly ingestPolled: (
		events: ReadonlyArray<unknown>,
		nowMs: number,
	) => Effect.Effect<number, ApiError, BillingUsageSourceContext>;
	readonly poll?: (input: {
		readonly env: BillingUsageSourceEnvironment;
		readonly api: BillingUsageRecovery;
		readonly nowMs: number;
	}) => Promise<number>;
}
