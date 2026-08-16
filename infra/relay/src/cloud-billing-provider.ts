import { Effect } from "effect";
import { allocatedComputeCostMicros } from "./cloud-billing.ts";
import { ensureAccountCloudBillingPeriod } from "./cloud-billing-period.ts";
import {
	CloudBillingStore,
	type CloudBillingUsageRecord,
} from "./cloud-billing-store.ts";
import { CloudWorkspaceStore } from "./cloud-workspace-store.ts";
import { RelayConfiguration } from "./config.ts";
import { conflict } from "./errors.ts";

export interface ProviderPriceWindow {
	readonly startedAtMs: number;
	readonly endedAtMs: number;
	readonly baseNanoUsdPerSecond?: number;
	readonly cpuNanoUsdPerSecond: number;
	readonly memoryNanoUsdPerGibSecond: number;
}

export interface ProviderExecutionEvidence {
	readonly provider: string;
	readonly eventId: string;
	readonly providerExecutionId?: string;
	readonly internalResourceId: string;
	readonly startedAtMs: number;
	readonly endedAtMs: number;
	readonly vcpuCount: number;
	readonly memoryMib: number;
}

export type ProviderMeteringReason =
	| "unmatched"
	| "no-period"
	| "cutover-not-configured"
	| "pre-cutover";

export const billingPeriodsCoverInterval = (
	periods: ReadonlyArray<{
		readonly periodStartMs: number;
		readonly periodEndMs: number;
	}>,
	startedAtMs: number,
	endedAtMs: number,
): boolean => {
	let coveredUntil = startedAtMs;
	for (const period of periods) {
		if (period.periodEndMs <= coveredUntil) continue;
		if (period.periodStartMs > coveredUntil) return false;
		coveredUntil = Math.max(coveredUntil, period.periodEndMs);
		if (coveredUntil >= endedAtMs) return true;
	}
	return false;
};

/**
 * Price windows affect cost, never financial identity. Provider adapters map
 * their lifecycle evidence into this provider-neutral period record.
 */
export const priceProviderExecutionPeriod = (input: {
	readonly provider: string;
	readonly eventId: string;
	readonly periodId: string;
	readonly startedAtMs: number;
	readonly endedAtMs: number;
	readonly vcpuCount: number;
	readonly memoryMib: number;
	readonly prices: ReadonlyArray<ProviderPriceWindow>;
}) => {
	const providerEventId = `${input.eventId}:${input.periodId}`;
	return {
		entryId: `${input.provider}:${providerEventId}`,
		providerEventId,
		startedAt: input.startedAtMs,
		endedAt: input.endedAtMs,
		providerCostMicros: input.prices.reduce(
			(total, price) =>
				total +
				allocatedComputeCostMicros({
					durationMs: price.endedAtMs - price.startedAtMs,
					vcpuCount: input.vcpuCount,
					memoryMib: input.memoryMib,
					baseNanoUsdPerSecond: price.baseNanoUsdPerSecond,
					cpuNanoUsdPerSecond: price.cpuNanoUsdPerSecond,
					memoryNanoUsdPerGibSecond: price.memoryNanoUsdPerGibSecond,
				}),
			0,
		),
	};
};

export const meterProviderExecution = Effect.fn("meterProviderExecution")(
	function* (input: {
		readonly evidence: ProviderExecutionEvidence;
		readonly nowMs: number;
	}) {
		const { evidence } = input;
		const billingStore = yield* CloudBillingStore;
		if (
			yield* billingStore.isProviderEventFinalized(
				evidence.provider,
				evidence.eventId,
				evidence.providerExecutionId,
			)
		)
			return { metered: false };
		if (
			!Number.isSafeInteger(evidence.startedAtMs) ||
			!Number.isSafeInteger(evidence.endedAtMs) ||
			evidence.endedAtMs <= evidence.startedAtMs ||
			!Number.isSafeInteger(evidence.vcpuCount) ||
			evidence.vcpuCount < 0 ||
			!Number.isSafeInteger(evidence.memoryMib) ||
			evidence.memoryMib < 0 ||
			evidence.endedAtMs > input.nowMs + 5 * 60_000
		)
			return yield* Effect.fail(conflict("invalid_provider_execution"));

		const workspaces = yield* CloudWorkspaceStore;
		const workspace = yield* workspaces.getWorkspace(
			evidence.internalResourceId,
		);
		const build =
			workspace === null
				? yield* workspaces.getBuild(evidence.internalResourceId)
				: null;
		const resource = workspace ?? build;
		if (resource === null)
			return { metered: false, reason: "unmatched" as const };

		const period = yield* ensureAccountCloudBillingPeriod(
			resource.accountId,
			input.nowMs,
		);
		if (period === null)
			return { metered: false, reason: "no-period" as const };

		const cutoverAt = (yield* RelayConfiguration).cloudBillingCutoverAtMs;
		if (cutoverAt === undefined)
			return { metered: false, reason: "cutover-not-configured" as const };
		if (evidence.endedAtMs <= cutoverAt)
			return { metered: false, reason: "pre-cutover" as const };

		const startedAt = Math.max(evidence.startedAtMs, cutoverAt);
		const periods = yield* billingStore.periodsOverlapping(
			resource.accountId,
			startedAt,
			evidence.endedAtMs,
		);
		if (!billingPeriodsCoverInterval(periods, startedAt, evidence.endedAtMs)) {
			console.warn(
				"[cloud-billing] provider execution period coverage pending",
				{
					provider: evidence.provider,
					eventId: evidence.eventId,
					providerExecutionId: evidence.providerExecutionId,
					accountId: resource.accountId,
					startedAt,
					endedAt: evidence.endedAtMs,
				},
			);
			return { metered: false, reason: "no-period" as const };
		}

		const usage: Array<CloudBillingUsageRecord> = [];
		for (const executionPeriod of periods) {
			const segmentStart = Math.max(startedAt, executionPeriod.periodStartMs);
			const segmentEnd = Math.min(
				evidence.endedAtMs,
				executionPeriod.periodEndMs,
			);
			const prices = yield* billingStore.priceWindows(
				evidence.provider,
				segmentStart,
				segmentEnd,
			);
			if (prices.length === 0)
				return yield* Effect.fail(conflict("cloud_billing_price_missing"));
			const priced = priceProviderExecutionPeriod({
				provider: evidence.provider,
				eventId: evidence.eventId,
				periodId: executionPeriod.periodId,
				startedAtMs: segmentStart,
				endedAtMs: segmentEnd,
				vcpuCount: evidence.vcpuCount,
				memoryMib: evidence.memoryMib,
				prices,
			});
			usage.push({
				...priced,
				periodId: executionPeriod.periodId,
				accountId: resource.accountId,
				resourceKind: workspace === null ? "build" : "workspace",
				resourceId: evidence.internalResourceId,
				provider: evidence.provider,
				providerExecutionId: evidence.providerExecutionId,
				vcpuCount: evidence.vcpuCount,
				memoryMib: evidence.memoryMib,
				status: "confirmed",
				nowMs: input.nowMs,
			});
		}

		return {
			metered: yield* billingStore.recordProviderExecutionBatch({
				provider: evidence.provider,
				eventId: evidence.eventId,
				providerExecutionId: evidence.providerExecutionId,
				finalizedAtMs: input.nowMs,
				usage,
			}),
		};
	},
);
