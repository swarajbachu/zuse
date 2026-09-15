import { Effect, Redacted, Schema } from "effect";
import {
	E2bLifecycleEvent,
	ingestE2bLifecycleEvent,
	normalizeE2bLifecycleEvent,
} from "../cloud-billing-e2b.ts";
import {
	type BillingUsageSourceModule,
	billingApiBaseUrl,
	billingPollRequest,
} from "../cloud-billing-usage-source.ts";
import { ApiConfiguration } from "../config.ts";
import { badRequest, unauthorized } from "../errors.ts";

const json = (body: unknown, status: number) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

export const verifyE2bSignature = (
	body: string,
	signature: string,
	secret: string,
) =>
	Effect.promise(async () => {
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(secret + body),
		);
		const actual = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(
			/=+$/u,
			"",
		);
		if (actual.length !== signature.length) return false;
		let difference = 0;
		for (let index = 0; index < actual.length; index++)
			difference |= actual.charCodeAt(index) ^ signature.charCodeAt(index);
		return difference === 0;
	});

const PollEnvironment = Schema.Struct({
	E2B_API_KEY: Schema.optionalKey(Schema.String),
	E2B_API_BASE_URL: Schema.optionalKey(Schema.String),
	CLOUD_BILLING_CUTOVER_AT: Schema.optionalKey(Schema.String),
});

const isConfigured = (value: string | undefined): value is string =>
	value !== undefined && value.trim() !== "";

export const E2bBillingUsageSourceModule: BillingUsageSourceModule = {
	provider: "e2b",
	ingestWebhook: ({ request, nowMs }) =>
		Effect.gen(function* () {
			const secret = (yield* ApiConfiguration).providerWebhookSecrets?.get(
				"e2b",
			);
			const signature = request.headers.get("e2b-signature");
			if (secret === undefined || signature === null) {
				console.warn("[cloud-billing] rejected unsigned E2B lifecycle event");
				return yield* Effect.fail(unauthorized("invalid_e2b_event"));
			}
			const raw = yield* Effect.promise(() => request.text());
			if (
				!(yield* verifyE2bSignature(raw, signature, Redacted.value(secret)))
			) {
				console.warn(
					"[cloud-billing] rejected invalid E2B lifecycle signature",
				);
				return yield* Effect.fail(unauthorized("invalid_e2b_event"));
			}
			const payload = yield* Effect.try({
				try: () => JSON.parse(raw),
				catch: () => badRequest("invalid_e2b_event"),
			});
			const event = yield* Schema.decodeUnknownEffect(E2bLifecycleEvent)(
				payload,
			).pipe(Effect.mapError(() => badRequest("invalid_e2b_event")));
			const result = yield* ingestE2bLifecycleEvent({
				event,
				rawPayload: payload,
				source: "webhook",
				deliveryId:
					request.headers.get("e2b-delivery-id") ?? `webhook:${event.id}`,
				nowMs,
			});
			return json(
				{ accepted: true, metered: result.metered, reason: result.reason },
				result.metered ? 200 : 202,
			);
		}),
	ingestPolled: (events, nowMs) =>
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
	poll: async ({ env, api, nowMs }) => {
		const config = Schema.decodeUnknownSync(PollEnvironment)(env);
		if (
			!isConfigured(config.E2B_API_KEY) ||
			!isConfigured(config.CLOUD_BILLING_CUTOVER_AT)
		)
			return 0;
		const cutoverAtMs = Date.parse(config.CLOUD_BILLING_CUTOVER_AT);
		const apiBaseUrl = billingApiBaseUrl(
			config.E2B_API_BASE_URL ?? "https://api.e2b.app",
		);
		const recovered: Array<unknown> = [];
		let offset = 0;
		let reachedCutover = false;
		while (!reachedCutover && offset < 10_000) {
			const query = new URLSearchParams({
				limit: "100",
				offset: String(offset),
				orderAsc: "false",
			});
			query.append("types", "sandbox.lifecycle.paused");
			query.append("types", "sandbox.lifecycle.killed");
			const response = await billingPollRequest(
				`${apiBaseUrl}/events/sandboxes?${query}`,
				{ "x-api-key": config.E2B_API_KEY },
			);
			if (!response.ok)
				throw new Error(`E2B lifecycle poll failed: ${response.status}`);
			const payload: unknown = await response.json();
			if (!Array.isArray(payload))
				throw new Error("E2B lifecycle poll was not an array");
			for (const event of payload) {
				if (typeof event !== "object" || event === null) continue;
				const eventRecord = event as Record<string, unknown>;
				const eventId = eventRecord.id;
				if (typeof eventId !== "string") continue;
				const timestamp =
					typeof eventRecord.timestamp === "string"
						? Date.parse(eventRecord.timestamp)
						: Number.NaN;
				if (Number.isFinite(timestamp) && timestamp < cutoverAtMs) {
					reachedCutover = true;
					break;
				}
				const providerExecutionId =
					typeof eventRecord.sandbox_execution_id === "string"
						? eventRecord.sandbox_execution_id
						: typeof eventRecord.sandboxExecutionId === "string"
							? eventRecord.sandboxExecutionId
							: undefined;
				if (
					await api.hasFinalizedProviderBillingEvent(
						"e2b",
						eventId,
						providerExecutionId,
					)
				)
					continue;
				recovered.push(event);
			}
			if (reachedCutover || payload.length < 100) break;
			offset += payload.length;
		}
		if (!reachedCutover && offset >= 10_000)
			console.error("[cloud-billing] E2B recovery exceeded 10,000 events");
		return api.ingestProviderBillingEvents("e2b", recovered.reverse(), nowMs);
	},
};
