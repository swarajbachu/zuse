import {
	ApiPaths,
	CloudBillingCapRequest,
	CloudBillingUsageRequest,
} from "@zuse/contracts";
import { Clock, Effect, Redacted, Schema } from "effect";
import { requireWorkos } from "./auth.ts";
import { type BetaAccess, requireCloudBetaAccess } from "./beta-access.ts";
import {
	E2bLifecycleEvent,
	ingestE2bLifecycleEvent,
} from "./cloud-billing-e2b.ts";
import { ensureAccountCloudBillingPeriod } from "./cloud-billing-period.ts";
import { CloudBillingStore } from "./cloud-billing-store.ts";
import type { CloudWorkspaceStore } from "./cloud-workspace-store.ts";
import { ApiConfiguration } from "./config.ts";
import { type ApiError, badRequest, conflict, unauthorized } from "./errors.ts";
import type { MachineStore } from "./machine-store.ts";
import type { WorkosVerifier } from "./workos.ts";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
const decodeBody = <A, I>(schema: Schema.Codec<A, I>, request: Request) =>
	Effect.tryPromise({
		try: () => request.json(),
		catch: () => badRequest("invalid_json"),
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(schema)),
		Effect.mapError(() => badRequest("invalid_request")),
	);

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

export type CloudBillingRouteContext =
	| CloudWorkspaceStore
	| MachineStore
	| ApiConfiguration
	| WorkosVerifier
	| BetaAccess
	| CloudBillingStore;

export const routeCloudBillingRequest = (
	request: Request,
): Effect.Effect<Response | null, ApiError, CloudBillingRouteContext> =>
	Effect.gen(function* () {
		const url = new URL(request.url);
		const method = request.method.toUpperCase();
		const nowMs = yield* Clock.currentTimeMillis;
		const billingPath = url.pathname.startsWith("/v1/cloud/billing/");
		if (!billingPath) return null;
		const billingStore = yield* CloudBillingStore;

		if (method === "POST" && url.pathname === "/v1/cloud/billing/webhook/e2b") {
			const secret = (yield* ApiConfiguration).e2bWebhookSecret;
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
			}).pipe(Effect.provideService(CloudBillingStore, billingStore));
			return json(
				{ accepted: true, metered: result.metered, reason: result.reason },
				result.metered ? 200 : 202,
			);
		}

		if (
			url.pathname !== ApiPaths.cloudBillingSummary &&
			url.pathname !== ApiPaths.cloudBillingUsage &&
			url.pathname !== ApiPaths.cloudBillingCap
		)
			return null;
		const principal = yield* requireWorkos(request);
		yield* requireCloudBetaAccess(principal.accountId);
		const period = yield* ensureAccountCloudBillingPeriod(
			principal.accountId,
			nowMs,
		).pipe(Effect.provideService(CloudBillingStore, billingStore));
		if (period === null)
			return yield* Effect.fail(
				conflict("cloud_billing_subscription_required"),
			);
		if (method === "GET" && url.pathname === ApiPaths.cloudBillingSummary)
			return json(yield* billingStore.summary(period));
		if (method === "GET" && url.pathname === ApiPaths.cloudBillingUsage) {
			const body = Schema.decodeUnknownSync(CloudBillingUsageRequest)({
				cursor: url.searchParams.get("cursor") ?? undefined,
				limit: Number(url.searchParams.get("limit") ?? 50),
			});
			return json(
				yield* billingStore.listUsage(
					period.periodId,
					body.cursor,
					Math.max(1, Math.min(100, Math.trunc(body.limit ?? 50))),
				),
			);
		}
		if (method === "POST" && url.pathname === ApiPaths.cloudBillingCap) {
			const body = yield* decodeBody(CloudBillingCapRequest, request);
			if (
				!Number.isSafeInteger(body.overageCapMicros) ||
				body.overageCapMicros < 0 ||
				body.idempotencyKey.length === 0
			)
				return yield* Effect.fail(badRequest("invalid_billing_cap"));
			const updated = yield* billingStore.setCap(
				period,
				body.overageCapMicros,
				nowMs,
				body.idempotencyKey,
			);
			if (updated === "below-incurred")
				return yield* Effect.fail(conflict("billing_cap_below_incurred"));
			if (updated === "idempotency-conflict")
				return yield* Effect.fail(conflict("billing_cap_idempotency_conflict"));
			return json(yield* billingStore.summary(updated));
		}
		return null;
	});
