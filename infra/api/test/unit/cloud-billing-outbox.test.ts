import {
	BillingProviderManual,
	BillingProviders,
} from "@zuse/billing-providers";
import { makeSandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import {
	maintainCloudBilling,
	reconcilePolarCloudMeter,
} from "../../src/cloud-billing-outbox.ts";
import { CloudBillingStore } from "../../src/cloud-billing-store.ts";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";
import { CloudWorkspaceStoreMemory } from "../../src/cloud-workspace-store.ts";
import * as Config from "../../src/config.ts";
import { MachineStoreMemory } from "../../src/machine-store.ts";

const memoryStore = Effect.runSync(
	Effect.gen(function* () {
		return yield* CloudBillingStore;
	}).pipe(Effect.provide(CloudBillingStoreMemory)),
);

describe("cloud billing outbox", () => {
	test("snapshot inventory defects do not block Polar exports or event purges", async () => {
		const calls: string[] = [];
		const store = CloudBillingStore.of({
			...memoryStore,
			snapshots: {
				...memoryStore.snapshots,
				list: () => Effect.die(new Error("inventory unavailable")),
			},
			pendingOutbox: () =>
				Effect.sync(() => {
					calls.push("invoice");
					return [];
				}),
			pendingUsageExports: () =>
				Effect.sync(() => {
					calls.push("usage");
					return [];
				}),
			pendingMeterReconciliations: () =>
				Effect.sync(() => {
					calls.push("meter");
					return [];
				}),
			purgeExpiredRawEvents: () =>
				Effect.sync(() => {
					calls.push("purge");
					return 1;
				}),
		});
		const polar = {
			...BillingProviderManual,
			providerId: "polar",
			reportMeterEvent: () => Effect.void,
			reconcileMeter: () => Effect.succeed(0),
		};
		const layer = Layer.mergeAll(
			Config.layer({
				apiIssuer: "https://api.test",
				workosJwksUrl: "https://unused.test/jwks",
				workosIssuer: "https://unused.test",
				mintPrivateKey: Redacted.make("{}"),
				mintPublicKey: "{}",
				cloudBillingExportEnabled: true,
				cloudUsageExportEnabled: true,
				cloudBillingPolarMeterId: "meter",
			}),
			Layer.succeed(CloudBillingStore, store),
			CloudWorkspaceStoreMemory,
			MachineStoreMemory,
			makeSandboxProvidersFake(),
			BillingProviders.layer({
				adapters: [polar],
				defaultProviderId: "polar",
			}).pipe(Layer.orDie),
		);
		await expect(
			Effect.runPromise(
				maintainCloudBilling(1_000_000).pipe(Effect.provide(layer)),
			),
		).resolves.toEqual({
			exported: 0,
			usageExported: 0,
			meterReconciled: 0,
			purgedRawEvents: 1,
		});
		expect(calls).toEqual(["invoice", "usage", "meter", "purge"]);
	});
	test("records Polar's authoritative meter total after exports settle", async () => {
		const reconciliations: Array<unknown> = [];
		const store = CloudBillingStore.of({
			...memoryStore,
			pendingMeterReconciliations: () =>
				Effect.succeed([
					{
						periodId: "period_1",
						accountId: "account_1",
						expectedUnits: 125,
					},
				]),
			recordMeterReconciliation: (input) =>
				Effect.sync(() => reconciliations.push(input)).pipe(Effect.asVoid),
		});
		const polar = {
			...BillingProviderManual,
			providerId: "polar",
			reconcileMeter: () => Effect.succeed(125),
		};
		const layer = Layer.mergeAll(
			Config.layer({
				apiIssuer: "https://api.test",
				workosJwksUrl: "https://unused.test/jwks",
				workosIssuer: "https://unused.test",
				mintPrivateKey: Redacted.make("{}"),
				mintPublicKey: '{"kty":"OKP"}',
				cloudBillingPolarMeterId: "meter_overage",
			}),
			Layer.succeed(CloudBillingStore, store),
			BillingProviders.layer({
				adapters: [polar],
				defaultProviderId: "polar",
			}).pipe(Layer.orDie),
		);

		await expect(
			Effect.runPromise(
				reconcilePolarCloudMeter(1_000_000).pipe(Effect.provide(layer)),
			),
		).resolves.toBe(1);
		expect(reconciliations).toEqual([
			{
				periodId: "period_1",
				provider: "polar",
				expectedUnits: 125,
				observedUnits: 125,
				nowMs: 1_000_000,
			},
		]);
	});
});

test("routes historical and Stripe charges by their persisted ownership", async () => {
	const sent: Array<{
		provider: string;
		timestamp: number | undefined;
		units: number;
	}> = [];
	const acknowledgments: string[] = [];
	const retries: string[] = [];
	const store = CloudBillingStore.of({
		...memoryStore,
		pendingOutbox: () =>
			Effect.succeed([
				{
					outboxId: "old",
					periodId: "polar_period",
					accountId: "account",
					provider: "polar",
					amountCents: 100,
					idempotencyKey: "old",
					occurredAtMs: 500,
					createdAtMs: 900,
				},
				{
					outboxId: "new",
					periodId: "stripe_period",
					accountId: "account",
					provider: "stripe",
					amountCents: 125,
					idempotencyKey: "new",
					occurredAtMs: 750,
					createdAtMs: 950,
				},
				{
					outboxId: "unavailable",
					periodId: "other",
					accountId: "account",
					provider: "missing",
					amountCents: 20,
					idempotencyKey: "missing",
					occurredAtMs: 800,
					createdAtMs: 950,
				},
			]),
		acknowledgeOutbox: (id) =>
			Effect.sync(() => {
				acknowledgments.push(id);
			}),
		retryOutbox: (id) =>
			Effect.sync(() => {
				retries.push(id);
			}),
	});
	const adapter = (providerId: string) => ({
		...BillingProviderManual,
		providerId,
		reportMeterEvent: (input: { units: number; occurredAtMs?: number }) =>
			Effect.sync(() => {
				sent.push({
					provider: providerId,
					timestamp: input.occurredAtMs,
					units: input.units,
				});
			}),
	});
	const { flushCloudBillingOutbox } = await import(
		"../../src/cloud-billing-outbox.ts"
	);
	const layer = Layer.merge(
		Layer.succeed(CloudBillingStore, store),
		BillingProviders.layer({
			adapters: [adapter("polar"), adapter("stripe")],
			defaultProviderId: "stripe",
		}).pipe(Layer.orDie),
	);
	expect(
		await Effect.runPromise(
			flushCloudBillingOutbox(1_000).pipe(Effect.provide(layer)),
		),
	).toBe(2);
	expect(sent).toEqual([
		{ provider: "polar", timestamp: 500, units: 100 },
		{ provider: "stripe", timestamp: 750, units: 125 },
	]);
	expect(acknowledgments).toEqual(["old", "new"]);
	expect(retries).toEqual(["unavailable"]);
});
