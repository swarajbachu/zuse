import { Effect } from "effect";
import { allocatedComputeCostMicros } from "./cloud-billing.ts";
import { billingPeriodsCoverInterval } from "./cloud-billing-provider.ts";
import type {
	CloudBillingStoreApi,
	CloudBillingUsageRecord,
} from "./cloud-billing-store.ts";
import type { RuntimeUsageEvent } from "./cloud-usage-store.ts";

/** Separate catalog: these USD estimates are not Boxd-reported costs. */
export const BOXD_ESTIMATE_PRICE_PROVIDER = "boxd-estimate";

export const estimatedRuntimeUsage = Effect.fn("estimatedRuntimeUsage")(
	function* (
		event: RuntimeUsageEvent,
		cutoverAtMs: number,
		store: Pick<CloudBillingStoreApi, "periodsOverlapping" | "priceWindows">,
	) {
		const { observation } = event;
		if (observation.provider !== "boxd") return [];
		const start = Math.max(event.startedAtMs, cutoverAtMs);
		if (start >= event.endedAtMs) return [];
		const periods = yield* store.periodsOverlapping(
			observation.accountId,
			start,
			event.endedAtMs,
		);
		if (!billingPeriodsCoverInterval(periods, start, event.endedAtMs))
			return yield* Effect.die(new Error("boxd_estimate_period_missing"));
		const prices = yield* store.priceWindows(
			BOXD_ESTIMATE_PRICE_PROVIDER,
			start,
			event.endedAtMs,
		);
		if (
			!billingPeriodsCoverInterval(
				prices.map((p) => ({
					periodStartMs: p.startedAtMs,
					periodEndMs: p.endedAtMs,
				})),
				start,
				event.endedAtMs,
			)
		)
			return yield* Effect.die(new Error("boxd_estimate_price_missing"));
		const records: CloudBillingUsageRecord[] = [];
		for (const period of periods) {
			for (const price of prices) {
				const startedAt = Math.max(
					start,
					period.periodStartMs,
					price.startedAtMs,
				);
				const endedAt = Math.min(
					event.endedAtMs,
					period.periodEndMs,
					price.endedAtMs,
				);
				if (endedAt <= startedAt) continue;
				const providerCostMicros = allocatedComputeCostMicros({
					durationMs: endedAt - startedAt,
					vcpuCount: observation.vcpuCount,
					memoryMib: observation.memoryMib,
					...price,
				});
				if (!Number.isSafeInteger(providerCostMicros) || providerCostMicros < 0)
					return yield* Effect.die(new Error("invalid_boxd_estimate_price"));
				records.push({
					entryId: `estimate:${event.eventId}:${period.periodId}:${price.version}`,
					periodId: period.periodId,
					accountId: observation.accountId,
					resourceKind: observation.resourceKind,
					resourceId: observation.resourceId,
					provider: observation.provider,
					providerSandboxId: observation.providerSandboxId,
					startedAt,
					endedAt,
					vcpuCount: observation.vcpuCount,
					memoryMib: observation.memoryMib,
					providerCostMicros,
					priceVersion: price.version,
					measurement: "estimated",
					status: "provisional",
					nowMs: observation.observedAtMs,
				});
			}
		}
		return records;
	},
);

/** Union matching settlement intervals so overlaps/redeliveries cannot release twice. */
export const outstandingEstimateMicros = (
	estimate: CloudBillingUsageRecord,
	confirmed: ReadonlyArray<CloudBillingUsageRecord>,
): number => {
	const ranges = confirmed
		.filter(
			(item) =>
				item.measurement !== "estimated" &&
				item.status !== "provisional" &&
				item.periodId === estimate.periodId &&
				item.accountId === estimate.accountId &&
				item.provider === estimate.provider &&
				item.providerSandboxId === estimate.providerSandboxId &&
				item.resourceKind === estimate.resourceKind &&
				item.resourceId === estimate.resourceId &&
				item.startedAt < estimate.endedAt &&
				item.endedAt > estimate.startedAt,
		)
		.map((item) => ({
			start: Math.max(item.startedAt, estimate.startedAt),
			end: Math.min(item.endedAt, estimate.endedAt),
		}))
		.sort((a, b) => a.start - b.start);
	let covered = 0;
	let until = estimate.startedAt;
	for (const range of ranges) {
		covered += Math.max(0, range.end - Math.max(until, range.start));
		until = Math.max(until, range.end);
	}
	const duration = estimate.endedAt - estimate.startedAt;
	return Number(
		(BigInt(estimate.providerCostMicros) * BigInt(duration - covered)) /
			BigInt(duration),
	);
};
