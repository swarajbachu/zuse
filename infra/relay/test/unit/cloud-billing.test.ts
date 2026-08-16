import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	calculateCloudBillingLedgerDeltas,
	calculateCloudBillingTotals,
	cloudBillingStatus,
	customerOverageCents,
	e2bExecutionCostMicros,
} from "../../src/cloud-billing.ts";
import { verifyE2bSignature } from "../../src/cloud-billing-routes.ts";

describe("cloud billing", () => {
	it("includes the first $35 of provider cost and marks up only overage", () => {
		expect(calculateCloudBillingTotals(40_000_000)).toEqual({
			providerCostMicros: 40_000_000,
			includedUsedMicros: 35_000_000,
			includedRemainingMicros: 0,
			overageProviderCostMicros: 5_000_000,
			overageChargeMicros: 5_250_000,
			currentInvoiceEstimateMicros: 45_250_000,
		});
	});

	it("does not roll unused allowance into the invoice", () => {
		expect(calculateCloudBillingTotals(2_000_000)).toMatchObject({
			includedUsedMicros: 2_000_000,
			includedRemainingMicros: 33_000_000,
			overageChargeMicros: 0,
			currentInvoiceEstimateMicros: 40_000_000,
		});
	});

	it("prices allocated E2B resources in integer micro-USD", () => {
		// 2 vCPU + 1 GiB for one hour = $0.117
		expect(
			e2bExecutionCostMicros({
				durationMs: 3_600_000,
				vcpuCount: 2,
				memoryMib: 1024,
			}),
		).toBe(117_000);
	});

	it("splits price changes without changing duration or using floats", () => {
		const firstHalf = e2bExecutionCostMicros({
			durationMs: 30 * 60_000,
			vcpuCount: 2,
			memoryMib: 1024,
			cpuNanoUsdPerSecond: 14_000,
			memoryNanoUsdPerGibSecond: 4_500,
		});
		const secondHalf = e2bExecutionCostMicros({
			durationMs: 30 * 60_000,
			vcpuCount: 2,
			memoryMib: 1024,
			cpuNanoUsdPerSecond: 28_000,
			memoryNanoUsdPerGibSecond: 9_000,
		});
		expect(firstHalf + secondHalf).toBe(175_500);
	});

	it("rounds only cumulative overage to Polar cents", () => {
		expect(customerOverageCents(4_999)).toBe(0);
		expect(customerOverageCents(5_000)).toBe(1);
		expect(customerOverageCents(25_004)).toBe(3);
	});

	it("records cap overshoot as Zuse cost and reverses it on correction", () => {
		const charged = calculateCloudBillingLedgerDeltas({
			beforeProviderCostMicros: 35_000_000,
			beforeChargedMicros: 0,
			providerCostDeltaMicros: 30_000_000,
			overageCapMicros: 25_000_000,
			manual: false,
		});
		expect(charged.overageChargeMicros).toBe(25_000_000);
		expect(charged.absorbedMicros).toBe(6_500_000);

		const corrected = calculateCloudBillingLedgerDeltas({
			beforeProviderCostMicros: 65_000_000,
			beforeChargedMicros: 25_000_000,
			providerCostDeltaMicros: -10_000_000,
			overageCapMicros: 25_000_000,
			manual: false,
		});
		expect(corrected.overageChargeMicros).toBe(-4_000_000);
		expect(corrected.absorbedMicros).toBe(-6_500_000);
	});

	it("rejects an invalid E2B webhook signature", async () => {
		expect(
			await verifyE2bSignature("{}", "unsigned", "webhook-secret").pipe(
				Effect.runPromise,
			),
		).toBe(false);
	});

	it("holds past-due and cap-exhausted accounts", () => {
		expect(
			cloudBillingStatus({
				subscriptionStatus: "grace",
				manual: false,
				overageProviderCostMicros: 0,
				overageChargeMicros: 0,
				overageCapMicros: 25_000_000,
			}),
		).toBe("billing-hold");
		expect(
			cloudBillingStatus({
				subscriptionStatus: "active",
				manual: false,
				overageProviderCostMicros: 25_000_000,
				overageChargeMicros: 25_000_000,
				overageCapMicros: 25_000_000,
			}),
		).toBe("billing-hold");
	});

	it("does not hold a zero-cap account before included usage is exhausted", () => {
		expect(
			cloudBillingStatus({
				subscriptionStatus: "active",
				manual: false,
				overageProviderCostMicros: 0,
				overageChargeMicros: 0,
				overageCapMicros: 0,
			}),
		).toBe("active");
	});
});
