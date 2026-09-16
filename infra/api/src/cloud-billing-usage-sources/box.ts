import { BOX_API_BASE_URL } from "@zuse/sandbox-providers/box";
import { Effect, Redacted, Schema } from "effect";
import {
	ingestBoxLifecycleEvent,
	normalizeBoxLifecycleEvent,
} from "../cloud-billing-box.ts";
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

const PolledBox = Schema.Struct({
	id: Schema.String.check(Schema.isNonEmpty()),
	name: Schema.optional(Schema.NullOr(Schema.String)),
	state: Schema.Literals(["archived", "error"]),
	updatedAt: Schema.String.check(
		Schema.makeFilter(
			(value) => Number.isFinite(Date.parse(value)) || "Invalid timestamp",
		),
	),
});
const PollPage = Schema.Struct({
	sandboxes: Schema.Array(Schema.Unknown),
	pageInfo: Schema.optional(
		Schema.Struct({
			nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
		}),
	),
});

const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60_000;

// X-Ascii-Signature: `v1=` + HMAC-SHA256 over `deliveryId.timestamp.rawBody`.
export const verifyBoxSignature = (input: {
	readonly rawBody: string;
	readonly deliveryId: string;
	readonly timestamp: string;
	readonly signature: string;
	readonly secret: string;
}) =>
	Effect.promise(async () => {
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(input.secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const digest = await crypto.subtle.sign(
			"HMAC",
			key,
			new TextEncoder().encode(
				`${input.deliveryId}.${input.timestamp}.${input.rawBody}`,
			),
		);
		const actual = `v1=${[...new Uint8Array(digest)]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("")}`;
		if (actual.length !== input.signature.length) return false;
		let difference = 0;
		for (let index = 0; index < actual.length; index++)
			difference |=
				actual.charCodeAt(index) ^ input.signature.charCodeAt(index);
		return difference === 0;
	});

const PollEnvironment = Schema.Struct({
	BOX_API_KEY: Schema.optionalKey(Schema.String),
	BOX_API_BASE_URL: Schema.optionalKey(Schema.String),
	CLOUD_BILLING_CUTOVER_AT: Schema.optionalKey(Schema.String),
});

const isConfigured = (value: string | undefined): value is string =>
	value !== undefined && value.trim() !== "";

export const BoxBillingUsageSourceModule: BillingUsageSourceModule = {
	provider: "box",
	ingestWebhook: ({ request, nowMs }) =>
		Effect.gen(function* () {
			const secret = (yield* ApiConfiguration).providerWebhookSecrets?.get(
				"box",
			);
			const deliveryId = request.headers.get("x-ascii-delivery");
			const timestamp = request.headers.get("x-ascii-timestamp");
			const signature = request.headers.get("x-ascii-signature");
			if (
				secret === undefined ||
				deliveryId === null ||
				timestamp === null ||
				signature === null
			) {
				console.warn("[cloud-billing] rejected unsigned Box lifecycle event");
				return yield* Effect.fail(unauthorized("invalid_box_event"));
			}
			const timestampMs = Number(timestamp) * 1_000;
			if (
				!Number.isFinite(timestampMs) ||
				Math.abs(nowMs - timestampMs) > WEBHOOK_TIMESTAMP_TOLERANCE_MS
			) {
				console.warn("[cloud-billing] rejected stale Box lifecycle event");
				return yield* Effect.fail(unauthorized("invalid_box_event"));
			}
			const raw = yield* Effect.promise(() => request.text());
			if (
				!(yield* verifyBoxSignature({
					rawBody: raw,
					deliveryId,
					timestamp,
					signature,
					secret: Redacted.value(secret),
				}))
			) {
				console.warn(
					"[cloud-billing] rejected invalid Box lifecycle signature",
				);
				return yield* Effect.fail(unauthorized("invalid_box_event"));
			}
			const payload = yield* Effect.try({
				try: () => JSON.parse(raw),
				catch: () => badRequest("invalid_box_event"),
			});
			const event = normalizeBoxLifecycleEvent(payload);
			if (event === null)
				return yield* Effect.fail(badRequest("invalid_box_event"));
			const result = yield* ingestBoxLifecycleEvent({
				event,
				rawPayload: payload,
				source: "webhook",
				deliveryId,
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
				const event = normalizeBoxLifecycleEvent(payload);
				if (event === null) continue;
				const result = yield* ingestBoxLifecycleEvent({
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
	// Box has no provider-side event log to replay, so recovery synthesizes
	// close events from currently archived/errored boxes. The synthetic event
	// id is stable per box transition (`updatedAt`), and window pairing plus
	// execution finalization keep re-observations idempotent. Webhooks
	// (at-least-once, 8 retries) remain the primary path; this only narrows
	// the crash window.
	poll: async ({ env, api, nowMs }) => {
		const config = Schema.decodeUnknownSync(PollEnvironment)(env);
		if (
			!isConfigured(config.BOX_API_KEY) ||
			!isConfigured(config.CLOUD_BILLING_CUTOVER_AT)
		)
			return 0;
		const apiBaseUrl = billingApiBaseUrl(
			config.BOX_API_BASE_URL ?? BOX_API_BASE_URL,
		);
		const synthesized: Array<unknown> = [];
		let cursor: string | undefined;
		for (let page = 0; page < 10; page++) {
			const query = new URLSearchParams({
				limit: "100",
				state: "archived,error",
			});
			if (cursor !== undefined) query.set("cursor", cursor);
			const response = await billingPollRequest(
				`${apiBaseUrl}/sandboxes?${query}`,
				{ authorization: `Bearer ${config.BOX_API_KEY}` },
			);
			if (!response.ok)
				throw new Error(`Box lifecycle poll failed: ${response.status}`);
			const payload = Schema.decodeUnknownSync(PollPage)(await response.json());
			for (const entry of payload.sandboxes) {
				const decoded = Schema.decodeUnknownOption(PolledBox)(entry);
				if (decoded._tag === "None") continue;
				const box = decoded.value;
				const observedAt = box.updatedAt;
				const eventId = `poll:${box.id}:${observedAt}`;
				if (await api.hasFinalizedProviderBillingEvent("box", eventId))
					continue;
				synthesized.push({
					id: eventId,
					type: box.state === "error" ? "box.error" : "box.archived",
					createdAt: observedAt,
					data: {
						box: { id: box.id, name: box.name ?? null },
						state: box.state,
					},
				});
			}
			const nextCursor = payload.pageInfo?.nextCursor ?? null;
			if (nextCursor === null || (payload.sandboxes?.length ?? 0) === 0) break;
			cursor = nextCursor;
		}
		return api.ingestProviderBillingEvents("box", synthesized, nowMs);
	},
};
