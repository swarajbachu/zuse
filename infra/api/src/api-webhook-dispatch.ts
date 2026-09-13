import { Clock, Effect, Option } from "effect";
import { ApiInternalWebhooks } from "./api-internal-webhooks.ts";
import {
	apiWebhookPayloadSealContext,
	apiWebhookSecretSealContext,
	openApiString,
} from "./api-sealing.ts";
import { safeApiWebhookTarget } from "./api-webhook-target.ts";
import { cloudWorkspaceGatewayEpoch } from "./cloud-workspace-runtime-fence.ts";
import {
	CloudWorkspaceStore,
	type DueApiWebhookDelivery,
} from "./cloud-workspace-store.ts";
import { ApiConfiguration } from "./config.ts";

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
const DELIVERY_CONCURRENCY = 8;
/** How long an API command may sit pending before the cron re-nudges. */
const STALE_COMMAND_NUDGE_MS = 60_000;
const API_DATA_RETENTION_MS = 30 * 24 * 60 * 60_000;

export const apiWebhookRetryDelayMs = (attempts: number): number =>
	Math.min(2 ** Math.max(0, attempts - 1) * 30_000, 60 * 60_000);

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
) {
	const store = yield* CloudWorkspaceStore;
	const config = yield* ApiConfiguration;
	const nowMs = yield* Clock.currentTimeMillis;
	const { delivery } = due;
	const recordFailure = (error: string, terminal = false) => {
		const attempts = delivery.attempts + 1;
		return store.failApiWebhookDelivery({
			deliveryId: delivery.deliveryId,
			nowMs,
			error,
			nextAttemptAtMs: nowMs + apiWebhookRetryDelayMs(attempts),
			terminal: terminal || attempts >= MAX_DELIVERY_ATTEMPTS,
		});
	};
	const receiver = yield* Effect.serviceOption(ApiInternalWebhooks);
	const internal =
		Option.isSome(receiver) && receiver.value.accepts(due.url)
			? receiver.value
			: undefined;
	const target = internal
		? new URL(due.url)
		: safeApiWebhookTarget(due.url, config.apiIssuer);
	if (target === null) {
		yield* recordFailure("unsafe_webhook_url", true);
		return false;
	}
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
		// Configuration can be transiently unavailable during a deploy. Keep the
		// durable row retryable instead of irreversibly dropping every claimed event.
		yield* recordFailure("payload_unsealable");
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
				const init: RequestInit = {
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
					redirect: "manual",
				};
				const response = await (internal
					? internal.receive(new Request(target, init))
					: fetch(target, init));
				const result = { ok: response.ok, status: response.status };
				await response.body?.cancel().catch(() => undefined);
				return result;
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
	yield* recordFailure(
		typeof outcome === "string"
			? outcome.slice(0, 500)
			: `http_${outcome.status}`,
	);
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
	const outcomes = yield* Effect.forEach(
		due,
		(item) => deliverOne(item).pipe(Effect.orElseSucceed(() => false)),
		{ concurrency: DELIVERY_CONCURRENCY },
	);
	return outcomes.filter(Boolean).length;
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
	// The cron runs every minute; hourly pruning keeps the sealed ledger bounded
	// without paying a ranking scan on every command nudge sweep.
	if (new Date(nowMs).getUTCMinutes() === 0)
		yield* store.pruneApiData(nowMs - API_DATA_RETENTION_MS);
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
			gatewayEpoch: cloudWorkspaceGatewayEpoch(workspace),
		});
	}
	return targets;
});
