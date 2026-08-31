import type {
	CloudBillingSummary,
	CloudBillingUsageItem,
} from "@zuse/contracts";
import { Effect, Layer } from "effect";
import {
	CLOUD_DEFAULT_OVERAGE_CAP_MICROS,
	calculateCloudBillingTotals,
	cloudBillingStatus,
	DEFAULT_CLOUD_BILLING_POLICY,
} from "./cloud-billing.ts";
import {
	type CloudBillingPeriodRecord,
	CloudBillingStore,
} from "./cloud-billing-store.ts";

/** Deterministic in-memory implementation for route and reconciler tests. */
export const CloudBillingStoreMemory = Layer.sync(CloudBillingStore, () => {
	const periods = new Map<string, CloudBillingPeriodRecord>();
	const events = new Set<string>();
	const finalizedEvents = new Set<string>();
	const usage = new Map<string, CloudBillingUsageItem & { periodId: string }>();
	const reservations = new Map<
		string,
		{
			readonly periodId: string;
			readonly item: CloudBillingUsageItem;
			readonly expiresAtMs: number;
		}
	>();
	const periodSummary = (
		period: CloudBillingPeriodRecord,
	): CloudBillingSummary => {
		const confirmedCost = [...usage.values()]
			.filter((item) => item.periodId === period.periodId)
			.reduce((total, item) => total + item.providerCostMicros, 0);
		const reservedCost = [...reservations.values()]
			.filter((item) => item.periodId === period.periodId)
			.reduce((total, item) => total + item.item.providerCostMicros, 0);
		const totals = calculateCloudBillingTotals(confirmedCost + reservedCost, {
			basePriceMicros: period.basePriceMicros,
			includedProviderCostMicros: period.includedProviderCostMicros,
			markupBasisPoints: period.markupBasisPoints,
		});
		const overageChargeMicros = Math.min(
			period.overageCapMicros,
			totals.overageChargeMicros,
		);
		return {
			currency: "USD",
			status: cloudBillingStatus({
				subscriptionStatus:
					period.status === "ended"
						? "ended"
						: period.status === "billing-hold" || period.status === "grace"
							? "grace"
							: "active",
				manual: period.status === "manual",
				overageProviderCostMicros: totals.overageProviderCostMicros,
				overageChargeMicros,
				overageCapMicros: period.overageCapMicros,
			}),
			periodStart: period.periodStartMs,
			periodEnd: period.periodEndMs,
			...totals,
			overageChargeMicros,
			currentInvoiceEstimateMicros:
				period.basePriceMicros + overageChargeMicros,
			basePriceMicros: period.basePriceMicros,
			includedProviderCostMicros: period.includedProviderCostMicros,
			overageCapMicros: period.overageCapMicros,
			markupBasisPoints: period.markupBasisPoints,
			lastProviderReconciledAt: undefined,
			lastPolarReconciledAt: undefined,
			usageProvisional: reservedCost > 0,
		};
	};
	return CloudBillingStore.of({
		hasProviderEvent: (provider, eventId) =>
			Effect.succeed(events.has(`${provider}:${eventId}`)),
		isProviderEventFinalized: (provider, eventId, providerExecutionId) =>
			Effect.succeed(
				finalizedEvents.has(`${provider}:event:${eventId}`) ||
					(providerExecutionId !== undefined &&
						finalizedEvents.has(
							`${provider}:execution:${providerExecutionId}`,
						)),
			),
		priceWindows: (_provider, startedAtMs, endedAtMs) =>
			Effect.succeed([
				{
					version: "test",
					startedAtMs,
					endedAtMs,
					baseNanoUsdPerSecond: 0,
					cpuNanoUsdPerSecond: 14_000,
					memoryNanoUsdPerGibSecond: 4_500,
				},
			]),
		recordProviderEvent: (input) =>
			Effect.sync(() => {
				const key = `${input.provider}:${input.eventId}`;
				if (events.has(key)) return false;
				events.add(key);
				return true;
			}),
		recordProviderDelivery: () => Effect.void,
		ensurePeriod: (input) =>
			Effect.sync(() => {
				const existing = [...periods.values()].find(
					(period) =>
						period.accountId === input.accountId &&
						period.periodStartMs === input.periodStartMs,
				);
				const period: CloudBillingPeriodRecord = {
					...(existing ?? {
						periodId: input.periodId,
						accountId: input.accountId,
						periodStartMs: input.periodStartMs,
						basePriceMicros: DEFAULT_CLOUD_BILLING_POLICY.basePriceMicros,
						includedProviderCostMicros:
							DEFAULT_CLOUD_BILLING_POLICY.includedProviderCostMicros,
						markupBasisPoints: DEFAULT_CLOUD_BILLING_POLICY.markupBasisPoints,
						priceCatalogVersion: "test",
						overageCapMicros:
							input.overageCapMicros ?? CLOUD_DEFAULT_OVERAGE_CAP_MICROS,
					}),
					providerSubscriptionId: input.providerSubscriptionId,
					status: input.status,
					periodEndMs: input.periodEndMs,
				};
				periods.set(period.periodId, period);
				return period;
			}),
		currentPeriod: (accountId, nowMs) =>
			Effect.succeed(
				[...periods.values()].find(
					(period) =>
						period.accountId === accountId &&
						period.periodStartMs <= nowMs &&
						period.periodEndMs > nowMs,
				) ?? null,
			),
		periodsOverlapping: (accountId, startedAtMs, endedAtMs) =>
			Effect.succeed(
				[...periods.values()].filter(
					(period) =>
						period.accountId === accountId &&
						period.periodStartMs < endedAtMs &&
						period.periodEndMs > startedAtMs,
				),
			),
		summary: (period) => Effect.sync(() => periodSummary(period)),
		setCap: (period, capMicros) =>
			Effect.sync(() => {
				const summary = periodSummary(period);
				if (capMicros < summary.overageChargeMicros) return "below-incurred";
				const updated = { ...period, overageCapMicros: capMicros };
				periods.set(period.periodId, updated);
				return updated;
			}),
		listUsage: (periodId, _cursor, limit) =>
			Effect.sync(() => {
				const items = [
					...[...usage.values()].filter((item) => item.periodId === periodId),
					...[...reservations.values()]
						.filter((item) => item.periodId === periodId)
						.map((item) => item.item),
				].slice(0, limit);
				return { items };
			}),
		recordProviderExecutionBatch: (batch) =>
			Effect.sync(() => {
				if (
					batch.usage.length === 0 ||
					batch.usage.some(
						(item) =>
							item.provider !== batch.provider ||
							item.providerExecutionId !== batch.providerExecutionId,
					)
				)
					throw new Error("invalid provider execution batch");
				const rawEventKey = `${batch.provider}:${batch.eventId}`;
				const eventKey = `${batch.provider}:event:${batch.eventId}`;
				const executionKey =
					batch.providerExecutionId === undefined
						? undefined
						: `${batch.provider}:execution:${batch.providerExecutionId}`;
				if (!events.has(rawEventKey))
					throw new Error("provider usage event missing");
				if (
					finalizedEvents.has(eventKey) ||
					(executionKey !== undefined && finalizedEvents.has(executionKey))
				)
					return false;
				let metered = false;
				for (const input of batch.usage) {
					if (usage.has(input.entryId)) continue;
					usage.set(input.entryId, input);
					reservations.delete(
						`${input.periodId}:${input.resourceKind}:${input.resourceId}`,
					);
					metered = true;
				}
				finalizedEvents.add(eventKey);
				if (executionKey !== undefined) finalizedEvents.add(executionKey);
				return metered;
			}),
		reserveCost: (input) =>
			Effect.sync(() => {
				const period = periods.get(input.periodId);
				if (period === undefined) throw new Error("billing period missing");
				reservations.set(
					`${input.periodId}:${input.resourceKind}:${input.resourceId}`,
					{
						periodId: input.periodId,
						expiresAtMs: input.expiresAtMs,
						item: {
							entryId: `reservation:${input.resourceKind}:${input.resourceId}`,
							resourceKind: input.resourceKind,
							resourceId: input.resourceId,
							provider: input.provider,
							startedAt: input.startedAtMs,
							endedAt: input.nowMs,
							vcpuCount: input.vcpuCount,
							memoryMib: input.memoryMib,
							providerCostMicros: input.providerCostMicros,
							status: "provisional",
						},
					},
				);
				const summary = periodSummary(period);
				return {
					summary,
					accepted:
						period.status === "manual" ||
						(period.status === "active" &&
							summary.overageChargeMicros <= period.overageCapMicros),
				};
			}),
		pendingOutbox: () => Effect.succeed([]),
		acknowledgeOutbox: () => Effect.void,
		retryOutbox: () => Effect.void,
		pendingMeterReconciliations: () => Effect.succeed([]),
		recordMeterReconciliation: () => Effect.void,
		purgeExpiredRawEvents: () => Effect.succeed(0),
	});
});
