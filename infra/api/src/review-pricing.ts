import {
	resolveSandboxResources,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { Effect } from "effect";
import { allocatedComputeCostMicros } from "./cloud-billing.ts";
import { ensureAccountCloudBillingPeriod } from "./cloud-billing-period.ts";
import { CloudBillingStore } from "./cloud-billing-store.ts";
import { serviceUnavailable } from "./errors.ts";
/** Conservative compute value including frozen period markup, before included allowance. */
export const reviewComputeValueMicros = (
	providerCostMicros: number,
	markupBasisPoints: number,
) => Math.ceil((providerCostMicros * (10000 + markupBasisPoints)) / 10000);
export const estimateReviewCost = Effect.fn("estimateReviewCost")(function* (
	provider: string,
	size: string,
	durationMs: number,
	nowMs: number,
) {
	const billing = yield* CloudBillingStore;
	const adapter = yield* (yield* SandboxProviders).get(provider);
	const resources = resolveSandboxResources(adapter, size);
	if (!adapter.sizes.some((s) => s.sizeId === size) || provider !== "e2b")
		return yield* serviceUnavailable("review_placement_unavailable");
	const windows = yield* billing.priceWindows(
		provider,
		nowMs,
		nowMs + durationMs,
	);
	if (
		windows.reduce((sum, w) => sum + w.endedAtMs - w.startedAtMs, 0) !==
		durationMs
	)
		return yield* serviceUnavailable("review_compute_price_unavailable");
	const maximumCostMicros = windows.reduce(
		(sum, w) =>
			sum +
			allocatedComputeCostMicros({
				...resources,
				durationMs: w.endedAtMs - w.startedAtMs,
				baseNanoUsdPerSecond: w.baseNanoUsdPerSecond,
				cpuNanoUsdPerSecond: w.cpuNanoUsdPerSecond,
				memoryNanoUsdPerGibSecond: w.memoryNanoUsdPerGibSecond,
			}),
		0,
	);
	return { maximumCostMicros, ...resources };
});
export const reserveReviewCost = Effect.fn("reserveReviewCost")(
	function* (input: {
		ownerId: string;
		id: string;
		provider: string;
		size: string;
		durationMs: number;
		nowMs: number;
		maxCostMicros?: number;
	}) {
		const period = yield* ensureAccountCloudBillingPeriod(
			input.ownerId,
			input.nowMs,
		);
		if (!period || period.periodEndMs < input.nowMs + input.durationMs)
			return yield* serviceUnavailable("review_billing_period_unavailable");
		const price = yield* estimateReviewCost(
			input.provider,
			input.size,
			input.durationMs,
			input.nowMs,
		);
		const grossMaximumCostMicros = reviewComputeValueMicros(
			price.maximumCostMicros,
			period.markupBasisPoints,
		);
		if (
			input.maxCostMicros !== undefined &&
			grossMaximumCostMicros > input.maxCostMicros
		)
			return yield* serviceUnavailable("review_run_budget_exceeded");
		const { maximumCostMicros, ...resources } = price;
		const accepted = yield* (yield* CloudBillingStore).reserveCost({
			accountId: input.ownerId,
			periodId: period.periodId,
			resourceKind: "review",
			resourceId: input.id,
			provider: input.provider,
			providerCostMicros: maximumCostMicros,
			startedAtMs: input.nowMs,
			...resources,
			nowMs: input.nowMs,
			expiresAtMs: input.nowMs + input.durationMs + 300000,
		});
		if (!accepted.accepted)
			return yield* serviceUnavailable("review_account_budget_exceeded");
		return grossMaximumCostMicros;
	},
);
