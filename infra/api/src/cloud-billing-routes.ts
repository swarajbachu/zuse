import {
	ApiPaths,
	CloudBillingCapRequest,
	CloudBillingUsageRequest,
} from "@zuse/contracts";
import type { SandboxProviders } from "@zuse/sandbox-providers";
import { Clock, Effect, Schema } from "effect";
import { requireWorkos } from "./auth.ts";
import { type BetaAccess, requireCloudBetaAccess } from "./beta-access.ts";
import { ensureAccountCloudBillingPeriod } from "./cloud-billing-period.ts";
import { CloudBillingStore } from "./cloud-billing-store.ts";
import { findBillingUsageSourceModule } from "./cloud-billing-usage-source-config.ts";
import type { CloudWorkspaceStore } from "./cloud-workspace-store.ts";
import type { ApiConfiguration } from "./config.ts";
import { type ApiError, badRequest, conflict } from "./errors.ts";
import { decodeBody, json } from "./http.ts";
import type { MachineStore } from "./machine-store.ts";
import type { WorkosVerifier } from "./workos.ts";

export { verifyE2bSignature } from "./cloud-billing-usage-sources/e2b.ts";

export type CloudBillingRouteContext =
	| CloudWorkspaceStore
	| MachineStore
	| ApiConfiguration
	| WorkosVerifier
	| BetaAccess
	| CloudBillingStore
	| SandboxProviders;

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

		const webhookMatch =
			/^\/v1\/cloud\/billing\/webhook\/([a-z][a-z0-9-]*)$/u.exec(url.pathname);
		if (method === "POST" && webhookMatch !== null) {
			const usageSource = findBillingUsageSourceModule(webhookMatch[1] ?? "");
			if (usageSource === undefined) return null;
			return yield* usageSource
				.ingestWebhook({ request, nowMs })
				.pipe(Effect.provideService(CloudBillingStore, billingStore));
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
