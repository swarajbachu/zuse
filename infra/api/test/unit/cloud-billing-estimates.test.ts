import {
	makeSandboxProviders,
	SandboxProviderError,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { makeSandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import {
	estimatedRuntimeUsage,
	outstandingEstimateMicros,
} from "../../src/cloud-billing-estimates.ts";
import {
	CloudBillingStore,
	type CloudBillingUsageRecord,
} from "../../src/cloud-billing-store.ts";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";
import type {
	RuntimeObservation,
	RuntimeUsageEvent,
} from "../../src/cloud-usage-store.ts";
import { reserveProviderCost } from "../../src/cloud-workspace-reconciler.ts";
import { layer as configLayer } from "../../src/config.ts";

const observation: RuntimeObservation = {
	accountId: "account",
	resourceKind: "workspace",
	resourceId: "workspace",
	provider: "boxd",
	providerSandboxId: "machine",
	runningSinceMs: 0,
	observedAtMs: 0,
	vcpuCount: 2,
	memoryMib: 8192,
};
const event: RuntimeUsageEvent = {
	eventId: "interval",
	observation: { ...observation, observedAtMs: 120_000 },
	startedAtMs: 0,
	endedAtMs: 120_000,
};
const setup = async () => {
	const store = await Effect.runPromise(
		CloudBillingStore.pipe(Effect.provide(CloudBillingStoreMemory)),
	);
	await Effect.runPromise(
		store.ensurePeriod({
			periodId: "period",
			accountId: "account",
			status: "active",
			periodStartMs: 0,
			periodEndMs: 3_600_000,
			nowMs: 0,
		}),
	);
	return store;
};

describe("durable estimated balance", () => {
	it("deducts observed usage even with export off, survives pauses, and deduplicates concurrent/stale samples", async () => {
		const store = await setup();
		const record = (observedAtMs: number, runningSinceMs: number | undefined) =>
			Effect.runPromise(
				store.recordRuntimeObservation(
					{ ...observation, observedAtMs, runningSinceMs },
					{ exportRuntime: false, estimateCutoverAtMs: 30_000 },
				),
			);
		await record(0, 0);
		await Promise.all([
			record(60_000, 0),
			record(60_000, 0),
			record(30_000, 0),
		]);
		await record(120_000, 0);
		await record(180_000, undefined);
		await record(240_000, undefined);
		const period = await Effect.runPromise(
			store.currentPeriod("account", 240_000),
		);
		if (!period) throw new Error("period missing");
		const summary = await Effect.runPromise(store.summary(period));
		// Test catalog: 2 * 14,000 + 8 * 4,500 nano-USD/sec, 90 seconds after cutover.
		expect(summary).toMatchObject({
			estimatedProviderCostMicros: 5760,
			providerCostMicros: 5760,
			includedRemainingMicros: 35_000_000 - 5760,
			usageProvisional: true,
		});
		expect(
			await Effect.runPromise(store.pendingUsageExports(240_000, 100)),
		).toEqual([]);
		expect(await Effect.runPromise(store.pendingOutbox(240_000, 100))).toEqual(
			[],
		);
		expect(
			(await Effect.runPromise(store.listUsage("period", undefined, 100)))
				.items,
		).toHaveLength(2);
	});
	it("splits at cutover, period and immutable price boundaries", async () => {
		const store = await setup();
		const first = await Effect.runPromise(store.currentPeriod("account", 0));
		if (!first) throw new Error("period missing");
		const items = await Effect.runPromise(
			estimatedRuntimeUsage(event, 30_000, {
				periodsOverlapping: () =>
					Effect.succeed([
						{ ...first, periodEndMs: 60_000 },
						{
							...first,
							periodId: "next",
							periodStartMs: 60_000,
							periodEndMs: 120_000,
						},
					]),
				priceWindows: () =>
					Effect.succeed([
						{
							version: "a",
							startedAtMs: 30_000,
							endedAtMs: 90_000,
							baseNanoUsdPerSecond: 0,
							cpuNanoUsdPerSecond: 500_000_000,
							memoryNanoUsdPerGibSecond: 0,
						},
						{
							version: "b",
							startedAtMs: 90_000,
							endedAtMs: 120_000,
							baseNanoUsdPerSecond: 0,
							cpuNanoUsdPerSecond: 1_000_000_000,
							memoryNanoUsdPerGibSecond: 0,
						},
					]),
			}),
		);
		expect(
			items.map((x) => [
				x.periodId,
				x.startedAt,
				x.endedAt,
				x.providerCostMicros,
				x.priceVersion,
			]),
		).toEqual([
			["period", 30_000, 60_000, 30_000_000, "a"],
			["next", 60_000, 90_000, 30_000_000, "a"],
			["next", 90_000, 120_000, 60_000_000, "b"],
		]);
	});
	it("fails closed on missing period or price coverage", async () => {
		const store = await setup();
		await expect(
			Effect.runPromise(
				estimatedRuntimeUsage(event, 0, {
					...store,
					priceWindows: () => Effect.succeed([]),
				}),
			),
		).rejects.toThrow("boxd_estimate_price_missing");
		await expect(
			Effect.runPromise(
				estimatedRuntimeUsage(event, 0, {
					...store,
					periodsOverlapping: () => Effect.succeed([]),
				}),
			),
		).rejects.toThrow("boxd_estimate_period_missing");
	});
	it("never fills outages, paused intervals, replacements, or size changes with estimated charges", async () => {
		for (const change of [
			{ observedAtMs: 121_000 },
			{ runningSinceMs: undefined },
			{ providerSandboxId: "replacement" },
			{ vcpuCount: 4 },
			{ memoryMib: 16384 },
		]) {
			const store = await setup();
			const options = { exportRuntime: false, estimateCutoverAtMs: 0 };
			await Effect.runPromise(
				store.recordRuntimeObservation(observation, options),
			);
			await Effect.runPromise(
				store.recordRuntimeObservation(
					{ ...observation, observedAtMs: 60_000, ...change },
					options,
				),
			);
			expect(
				(await Effect.runPromise(store.listUsage("period", undefined, 100)))
					.items,
			).toEqual([]);
		}
	});
	it("releases only the union of matching confirmed time, including partial settlement", () => {
		const estimate: CloudBillingUsageRecord = {
			entryId: "e",
			periodId: "p",
			accountId: "a",
			provider: "boxd",
			providerSandboxId: "vm",
			resourceKind: "workspace",
			resourceId: "w",
			startedAt: 0,
			endedAt: 100,
			vcpuCount: 2,
			memoryMib: 8192,
			providerCostMicros: 1000,
			status: "provisional",
			measurement: "estimated",
			nowMs: 100,
		};
		const confirmed = {
			...estimate,
			entryId: "c",
			status: "confirmed" as const,
			measurement: "provider" as const,
			startedAt: 20,
			endedAt: 60,
		};
		expect(
			outstandingEstimateMicros(estimate, [
				confirmed,
				{ ...confirmed, startedAt: 40, endedAt: 80 },
			]),
		).toBe(400);
		expect(
			outstandingEstimateMicros(estimate, [
				{ ...confirmed, providerSandboxId: "other" },
			]),
		).toBe(1000);
		expect(
			outstandingEstimateMicros(estimate, [
				{ ...confirmed, accountId: "other" },
			]),
		).toBe(1000);
		expect(
			outstandingEstimateMicros(estimate, [
				{ ...confirmed, startedAt: 0, endedAt: 100 },
			]),
		).toBe(0);
	});
});

it("enforces estimated deductions with invoice export disabled and reserves only forward time", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const store = yield* CloudBillingStore;
			const original = yield* (yield* SandboxProviders).getDefault;
			let inspectFails = false;
			const adapter = {
				...original,
				providerId: "boxd",
				inspect: () =>
					inspectFails
						? Effect.fail(
								new SandboxProviderError({
									code: "transient",
								}),
							)
						: Effect.succeed({
								providerSandboxId: "machine",
								providerLabel: "test",
								state: "running" as const,
							}),
			};
			const registry = yield* makeSandboxProviders({
				registrations: [{ adapter, advertised: true }],
				defaultProviderId: "boxd",
			});
			const period = yield* store.ensurePeriod({
				periodId: "cap",
				accountId: "account",
				status: "active",
				periodStartMs: 0,
				periodEndMs: 1_000_000,
				overageCapMicros: 0,
				nowMs: 0,
			});
			// Seed real durable estimates above the allowance; do not fake the summary.
			for (let time = 0; time <= 960_000; time += 120_000)
				yield* store.recordRuntimeObservation(
					{
						...observation,
						vcpuCount: 10000,
						memoryMib: 8192,
						observedAtMs: time,
					},
					{ exportRuntime: false, estimateCutoverAtMs: 0 },
				);
			expect((yield* store.summary(period)).includedRemainingMicros).toBe(0);
			const reserve = (nowMs: number) =>
				reserveProviderCost({ ...observation, nowMs }).pipe(
					Effect.provideService(SandboxProviders, registry),
				);
			expect(yield* reserve(960_000)).toBe(true);
			const reservations = (yield* store.listUsage(
				"cap",
				undefined,
				100,
			)).items.filter((item) => item.entryId.startsWith("reservation:"));
			expect(reservations).toHaveLength(1);
			expect(reservations[0]?.startedAt).toBe(960_000);
			expect(reservations[0]?.providerCostMicros).toBeLessThan(4000);
			inspectFails = true;
			expect(yield* reserve(961_000)).toBe(true);
		}).pipe(
			Effect.provide(CloudBillingStoreMemory),
			Effect.provide(makeSandboxProvidersFake()),
			Effect.provide(
				configLayer({
					apiIssuer: "https://api.test",
					workosJwksUrl: "https://unused.test",
					workosIssuer: "https://unused.test",
					mintPrivateKey: Redacted.make("{}"),
					mintPublicKey: "{}",
					cloudBoxdEstimatesCutoverAtMs: 0,
					cloudBillingEnforcementEnabled: false,
					cloudBillingExportEnabled: false,
					cloudUsageExportEnabled: false,
				}),
			),
		),
	);
});
