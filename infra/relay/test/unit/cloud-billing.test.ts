import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	allocatedComputeCostMicros,
	calculateCloudBillingLedgerDeltas,
	calculateCloudBillingTotals,
	cloudBillingStatus,
	customerOverageCents,
} from "../../src/cloud-billing.ts";
import { priceProviderExecutionPeriod } from "../../src/cloud-billing-provider.ts";
import { verifyE2bSignature } from "../../src/cloud-billing-routes.ts";
import { CloudBillingStore } from "../../src/cloud-billing-store.ts";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";

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

	it("prices allocated compute resources in integer micro-USD", () => {
		// 2 vCPU + 1 GiB for one hour = $0.117
		expect(
			allocatedComputeCostMicros({
				durationMs: 3_600_000,
				vcpuCount: 2,
				memoryMib: 1024,
				cpuNanoUsdPerSecond: 14_000,
				memoryNanoUsdPerGibSecond: 4_500,
			}),
		).toBe(117_000);
		expect(
			allocatedComputeCostMicros({
				durationMs: 1_000,
				vcpuCount: 0,
				memoryMib: 0,
				baseNanoUsdPerSecond: 1_000_000,
				cpuNanoUsdPerSecond: 0,
				memoryNanoUsdPerGibSecond: 0,
			}),
		).toBe(1_000);
	});

	it("splits price changes without changing duration or using floats", () => {
		const firstHalf = allocatedComputeCostMicros({
			durationMs: 30 * 60_000,
			vcpuCount: 2,
			memoryMib: 1024,
			cpuNanoUsdPerSecond: 14_000,
			memoryNanoUsdPerGibSecond: 4_500,
		});
		const secondHalf = allocatedComputeCostMicros({
			durationMs: 30 * 60_000,
			vcpuCount: 2,
			memoryMib: 1024,
			cpuNanoUsdPerSecond: 28_000,
			memoryNanoUsdPerGibSecond: 9_000,
		});
		expect(firstHalf + secondHalf).toBe(175_500);
	});

	it("keeps provider identity stable when the price catalog changes", () => {
		const common = {
			eventId: "event-1",
			periodId: "period-1",
			startedAtMs: 0,
			endedAtMs: 60_000,
			vcpuCount: 2,
			memoryMib: 1_024,
		};
		const original = priceProviderExecutionPeriod({
			...common,
			provider: "e2b",
			prices: [
				{
					startedAtMs: 0,
					endedAtMs: 60_000,
					cpuNanoUsdPerSecond: 14_000,
					memoryNanoUsdPerGibSecond: 4_500,
				},
			],
		});
		const catalogExtended = priceProviderExecutionPeriod({
			...common,
			provider: "e2b",
			prices: [
				{
					startedAtMs: 0,
					endedAtMs: 30_000,
					cpuNanoUsdPerSecond: 14_000,
					memoryNanoUsdPerGibSecond: 4_500,
				},
				{
					startedAtMs: 30_000,
					endedAtMs: 60_000,
					cpuNanoUsdPerSecond: 28_000,
					memoryNanoUsdPerGibSecond: 9_000,
				},
			],
		});

		expect(catalogExtended.providerCostMicros).not.toBe(
			original.providerCostMicros,
		);
		expect(catalogExtended.entryId).toBe(original.entryId);
		expect(catalogExtended.providerEventId).toBe(original.providerEventId);
	});

	it("finalizes a provider event across all periods atomically", async () => {
		const result = await Effect.gen(function* () {
			const store = yield* CloudBillingStore;
			yield* store.recordProviderEvent({
				provider: "e2b",
				eventId: "event-1",
				type: "paused",
				payload: {},
				receivedAtMs: 10,
				expiresAtMs: 20,
			});
			const usage = (eventId: string, periodId: string) => ({
				entryId: `e2b:${eventId}:${periodId}`,
				periodId,
				accountId: "account-1",
				resourceKind: "workspace" as const,
				resourceId: "workspace-1",
				provider: "e2b",
				providerEventId: `${eventId}:${periodId}`,
				providerExecutionId: "execution-1",
				startedAt: 0,
				endedAt: 10,
				vcpuCount: 2,
				memoryMib: 1_024,
				providerCostMicros: 100,
				status: "confirmed" as const,
				nowMs: 10,
			});
			const first = yield* store.recordProviderExecutionBatch({
				provider: "e2b",
				eventId: "event-1",
				providerExecutionId: "execution-1",
				finalizedAtMs: 10,
				usage: [usage("event-1", "period-1")],
			});
			const afterNewPeriod = yield* store.recordProviderExecutionBatch({
				provider: "e2b",
				eventId: "event-1",
				providerExecutionId: "execution-1",
				finalizedAtMs: 20,
				usage: [usage("event-1", "period-1"), usage("event-1", "period-2")],
			});
			yield* store.recordProviderEvent({
				provider: "e2b",
				eventId: "event-2",
				type: "killed",
				payload: {},
				receivedAtMs: 20,
				expiresAtMs: 30,
			});
			const sameExecution = yield* store.recordProviderExecutionBatch({
				provider: "e2b",
				eventId: "event-2",
				providerExecutionId: "execution-1",
				finalizedAtMs: 20,
				usage: [usage("event-2", "period-2")],
			});
			const finalized = yield* store.isProviderEventFinalized(
				"e2b",
				"event-2",
				"execution-1",
			);
			return { first, afterNewPeriod, sameExecution, finalized };
		}).pipe(Effect.provide(CloudBillingStoreMemory), Effect.runPromise);

		expect(result).toEqual({
			first: true,
			afterNewPeriod: false,
			sameExecution: false,
			finalized: true,
		});
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
