import { Clock, Effect } from "effect";
import {
	apiWebhookPayloadSealContext,
	apiWebhookSecretSealContext,
	openApiString,
} from "./api-sealing.ts";
import {
	CloudWorkspaceStore,
	type DueApiWebhookDelivery,
} from "./cloud-workspace-store.ts";
import type { ApiConfiguration } from "./config.ts";

// Webhook deliveries follow the house async pattern: durable Postgres rows
// swept by the cron reconciler, with a response-header fast path
// (`x-zuse-deliver-cloud-webhooks`) for low latency. Payloads are signed like
// Stripe/Slack webhooks: `zuse-signature: t=<unixSeconds>,v1=<hex hmac>` over
// `<t>.<rawBody>` with the per-endpoint `whsec_…` secret.

const DELIVERY_TIMEOUT_MS = 10_000;
/** Claim lease; a crashed sweep leaves rows retryable after this window. */
const DELIVERY_LEASE_MS = 2 * 60_000;
const DELIVERY_BATCH_LIMIT = 32;
const MAX_DELIVERY_ATTEMPTS = 20;
/** How long an API command may sit pending before the cron re-nudges. */
const STALE_COMMAND_NUDGE_MS = 60_000;

const backoffMs = (attempts: number): number =>
	Math.min(2 ** attempts * 30_000, 60 * 60_000);

export const signWebhookPayload = async (
	secret: string,
	timestampSeconds: number,
	body: string,
): Promise<string> => {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`${timestampSeconds}.${body}`),
	);
	return [...new Uint8Array(signature)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
};

const deliverOne = Effect.fn("deliverApiWebhook")(function* (
	due: DueApiWebhookDelivery,
	nowMs: number,
) {
	const store = yield* CloudWorkspaceStore;
	const { delivery } = due;
	const terminalFailure = (error: string) =>
		store.failApiWebhookDelivery({
			deliveryId: delivery.deliveryId,
			nowMs,
			error,
			nextAttemptAtMs: nowMs + backoffMs(delivery.attempts + 1),
			terminal: true,
		});
	const opened = yield* Effect.all({
		body: openApiString(
			apiWebhookPayloadSealContext(delivery.accountId, delivery.eventId),
			delivery.sealedPayload,
		),
		secret: openApiString(
			apiWebhookSecretSealContext(delivery.accountId, delivery.webhookId),
			due.sealedSecret,
		),
	}).pipe(Effect.option);
	if (opened._tag === "None") {
		// Undecryptable content never becomes deliverable; drop it.
		yield* terminalFailure("payload_unsealable");
		return false;
	}
	const timestampSeconds = Math.floor(nowMs / 1_000);
	const outcome: { readonly ok: boolean; readonly status: number } | string =
		yield* Effect.tryPromise({
			try: async () => {
				const signature = await signWebhookPayload(
					opened.value.secret,
					timestampSeconds,
					opened.value.body,
				);
				const response = await fetch(due.url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"user-agent": "zuse-webhooks/1",
						"zuse-event-id": delivery.eventId,
						"zuse-delivery-attempt": `${delivery.attempts + 1}`,
						"zuse-signature": `t=${timestampSeconds},v1=${signature}`,
					},
					body: opened.value.body,
					signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
				});
				return { ok: response.ok, status: response.status };
			},
			catch: (error) =>
				error instanceof Error ? error.message : "fetch_failed",
		}).pipe(
			Effect.catch((error: unknown) =>
				Effect.succeed(typeof error === "string" ? error : "fetch_failed"),
			),
		);
	if (typeof outcome !== "string" && outcome.ok) {
		yield* store.completeApiWebhookDelivery(delivery.deliveryId, nowMs);
		return true;
	}
	const attempts = delivery.attempts + 1;
	yield* store.failApiWebhookDelivery({
		deliveryId: delivery.deliveryId,
		nowMs,
		error:
			typeof outcome === "string"
				? outcome.slice(0, 500)
				: `http_${outcome.status}`,
		nextAttemptAtMs: nowMs + backoffMs(attempts),
		terminal: attempts >= MAX_DELIVERY_ATTEMPTS,
	});
	return false;
});

/**
 * Claim and deliver due webhook rows. Runs from the cron sweep and from the
 * `x-zuse-deliver-cloud-webhooks` fast path; both paths are safe to overlap
 * thanks to the claim lease. Returns how many deliveries succeeded.
 */
export const deliverPendingApiWebhooks: Effect.Effect<
	number,
	never,
	CloudWorkspaceStore | ApiConfiguration
> = Effect.gen(function* () {
	const store = yield* CloudWorkspaceStore;
	const nowMs = yield* Clock.currentTimeMillis;
	const due = yield* store.claimDueApiWebhookDeliveries(
		nowMs,
		DELIVERY_BATCH_LIMIT,
		DELIVERY_LEASE_MS,
	);
	let delivered = 0;
	for (const item of due) {
		if (yield* deliverOne(item, nowMs).pipe(Effect.orElseSucceed(() => false)))
			delivered++;
	}
	return delivered;
});

export interface ApiCommandNudgeTarget {
	readonly workspaceId: string;
	readonly gatewayEpoch: number;
}

/**
 * Cron half of API-command delivery: expire stale rows, then report which
 * online workspaces still have pending commands older than the nudge window so
 * the worker (which owns the Durable Object binding) can re-nudge them.
 */
export const sweepApiCommands: Effect.Effect<
	ReadonlyArray<ApiCommandNudgeTarget>,
	never,
	CloudWorkspaceStore
> = Effect.gen(function* () {
	const store = yield* CloudWorkspaceStore;
	const nowMs = yield* Clock.currentTimeMillis;
	yield* store.expireApiCommands(nowMs);
	const staleWorkspaceIds =
		yield* store.listWorkspacesWithStalePendingApiCommands(
			nowMs - STALE_COMMAND_NUDGE_MS,
		);
	const targets: Array<ApiCommandNudgeTarget> = [];
	for (const workspaceId of staleWorkspaceIds) {
		const workspace = yield* store.getWorkspace(workspaceId);
		if (workspace === null || workspace.runtimeState !== "online") continue;
		targets.push({
			workspaceId,
			gatewayEpoch:
				typeof workspace.requestConfig.gatewayEpoch === "number"
					? workspace.requestConfig.gatewayEpoch
					: typeof workspace.requestConfig.runtimeGeneration === "number"
						? workspace.requestConfig.runtimeGeneration
						: 1,
		});
	}
	return targets;
});
