import type { CloudBillingStatus } from "@zuse/contracts";

export const USD_MICROS = 1_000_000;
export const CLOUD_BASE_PRICE_MICROS = 40 * USD_MICROS;
export const CLOUD_INCLUDED_COST_MICROS = 35 * USD_MICROS;
export const CLOUD_DEFAULT_OVERAGE_CAP_MICROS = 25 * USD_MICROS;
export const CLOUD_MARKUP_BASIS_POINTS = 500;
export const CLOUD_PRICE_CATALOG_VERSION = "provider-compute-v1";

export interface CloudBillingPolicy {
	readonly basePriceMicros: number;
	readonly includedProviderCostMicros: number;
	readonly markupBasisPoints: number;
}

export interface CloudBillingTotals {
	readonly providerCostMicros: number;
	readonly includedUsedMicros: number;
	readonly includedRemainingMicros: number;
	readonly overageProviderCostMicros: number;
	readonly overageChargeMicros: number;
	readonly currentInvoiceEstimateMicros: number;
}

export interface CloudBillingLedgerDeltas {
	readonly includedAllowanceMicros: number;
	readonly overageProviderCostMicros: number;
	readonly overageChargeMicros: number;
	readonly markupMicros: number;
	readonly absorbedMicros: number;
}

export const DEFAULT_CLOUD_BILLING_POLICY: CloudBillingPolicy = {
	basePriceMicros: CLOUD_BASE_PRICE_MICROS,
	includedProviderCostMicros: CLOUD_INCLUDED_COST_MICROS,
	markupBasisPoints: CLOUD_MARKUP_BASIS_POINTS,
};

export const calculateCloudBillingTotals = (
	providerCostMicros: number,
	policy: CloudBillingPolicy = DEFAULT_CLOUD_BILLING_POLICY,
): CloudBillingTotals => {
	const cost = Math.max(0, Math.trunc(providerCostMicros));
	const includedUsedMicros = Math.min(cost, policy.includedProviderCostMicros);
	const overageProviderCostMicros = Math.max(
		0,
		cost - policy.includedProviderCostMicros,
	);
	const overageChargeMicros = Math.floor(
		(overageProviderCostMicros * (10_000 + policy.markupBasisPoints)) / 10_000,
	);
	return {
		providerCostMicros: cost,
		includedUsedMicros,
		includedRemainingMicros:
			policy.includedProviderCostMicros - includedUsedMicros,
		overageProviderCostMicros,
		overageChargeMicros,
		currentInvoiceEstimateMicros: policy.basePriceMicros + overageChargeMicros,
	};
};

/**
 * Calculates signed ledger deltas from cumulative totals. Keeping this pure is
 * important: corrections use the same policy as ordinary usage, and can undo
 * previously exported cents without rewriting history.
 */
export const calculateCloudBillingLedgerDeltas = (input: {
	readonly beforeProviderCostMicros: number;
	readonly beforeChargedMicros: number;
	readonly providerCostDeltaMicros: number;
	readonly overageCapMicros: number;
	readonly manual: boolean;
	readonly policy?: CloudBillingPolicy;
}): CloudBillingLedgerDeltas => {
	const policy = input.policy ?? DEFAULT_CLOUD_BILLING_POLICY;
	const before = calculateCloudBillingTotals(
		input.beforeProviderCostMicros,
		policy,
	);
	const after = calculateCloudBillingTotals(
		input.beforeProviderCostMicros + input.providerCostDeltaMicros,
		policy,
	);
	const beforeCharge = Math.max(0, Math.trunc(input.beforeChargedMicros));
	const targetCharge = input.manual
		? 0
		: Math.min(after.overageChargeMicros, input.overageCapMicros);
	const beforeMarkup = Math.max(
		0,
		beforeCharge - before.overageProviderCostMicros,
	);
	const afterMarkup = Math.max(
		0,
		targetCharge - after.overageProviderCostMicros,
	);
	return {
		includedAllowanceMicros:
			after.includedUsedMicros - before.includedUsedMicros,
		overageProviderCostMicros:
			after.overageProviderCostMicros - before.overageProviderCostMicros,
		overageChargeMicros: targetCharge - beforeCharge,
		markupMicros: afterMarkup - beforeMarkup,
		absorbedMicros:
			after.overageChargeMicros -
			targetCharge -
			(before.overageChargeMicros - beforeCharge),
	};
};

/** Polar is updated from the cumulative total, with rounding only at this edge. */
export const customerOverageCents = (overageChargeMicros: number): number =>
	Math.round(Math.max(0, Math.trunc(overageChargeMicros)) / 10_000);

export const cloudBillingStatus = (input: {
	readonly subscriptionStatus: "pending" | "active" | "grace" | "ended";
	readonly manual: boolean;
	readonly overageProviderCostMicros: number;
	readonly overageChargeMicros: number;
	readonly overageCapMicros: number;
}): CloudBillingStatus => {
	if (input.manual) return "manual";
	if (input.subscriptionStatus === "ended") return "ended";
	if (
		input.subscriptionStatus === "grace" ||
		(input.overageProviderCostMicros > 0 &&
			input.overageChargeMicros >= input.overageCapMicros)
	)
		return "billing-hold";
	return "active";
};

export const allocatedComputeCostMicros = (input: {
	readonly durationMs: number;
	readonly vcpuCount: number;
	readonly memoryMib: number;
	readonly baseNanoUsdPerSecond?: number;
	readonly cpuNanoUsdPerSecond: number;
	readonly memoryNanoUsdPerGibSecond: number;
}): number => {
	const durationMs = Math.max(0, Math.trunc(input.durationMs));
	const vcpus = Math.max(0, Math.trunc(input.vcpuCount));
	const memoryMib = Math.max(0, Math.trunc(input.memoryMib));
	return Math.floor(
		(durationMs *
			((input.baseNanoUsdPerSecond ?? 0) * 1024 +
				vcpus * input.cpuNanoUsdPerSecond * 1024 +
				memoryMib * input.memoryNanoUsdPerGibSecond)) /
			(1_000_000 * 1024),
	);
};
