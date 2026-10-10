import type { SandboxProviders } from "@zuse/sandbox-providers";
import { Effect } from "effect";
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

/** Normalize credentialed billing endpoints before any network request. */
export const billingApiBaseUrl = (value: string): string => {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error(
			"Billing API base URL must use HTTPS without credentials, query, or fragment",
		);
	return url.href.replace(/\/+$/u, "");
};

/** Bound both response headers and body reads, and never forward credentials on redirects. */
export const billingPollRequest = async (
	url: string,
	headers: HeadersInit,
): Promise<Response> => {
	const response = await fetch(url, {
		headers,
		// Workers supports manual redirects; never forward provider credentials.
		redirect: "manual",
		signal: AbortSignal.timeout(30_000),
	});
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel();
		throw new Error("Billing API redirects are not allowed");
	}
	return response;
};

/** A failed execution must stay retryable without starving the rest of a poll. */
export const ingestPolledBillingEvents = Effect.fn("ingestPolledBillingEvents")(
	function* <Event extends { readonly id: string }, R>(input: {
		readonly provider: string;
		readonly events: ReadonlyArray<unknown>;
		readonly normalize: (payload: unknown) => Event | null;
		readonly ingest: (
			event: Event,
			payload: unknown,
		) => Effect.Effect<{ readonly metered: boolean }, ApiError, R>;
	}) {
		let metered = 0;
		for (const payload of input.events) {
			const event = input.normalize(payload);
			if (event === null) continue;
			const result = yield* input.ingest(event, payload).pipe(Effect.result);
			if (result._tag === "Failure") {
				console.warn("[cloud-billing] polled execution settlement failed", {
					provider: input.provider,
					eventId: event.id,
					code: result.failure.code,
				});
				continue;
			}
			if (result.success.metered) metered++;
		}
		return metered;
	},
);
