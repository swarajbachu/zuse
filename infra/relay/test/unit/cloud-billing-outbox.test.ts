import {
	BillingProviderManual,
	BillingProviders,
} from "@zuse/billing-providers";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import { reconcilePolarCloudMeter } from "../../src/cloud-billing-outbox.ts";
import { CloudBillingStore } from "../../src/cloud-billing-store.ts";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";
import * as Config from "../../src/config.ts";

const memoryStore = Effect.runSync(
	Effect.gen(function* () {
		return yield* CloudBillingStore;
	}).pipe(Effect.provide(CloudBillingStoreMemory)),
);

describe("cloud billing outbox", () => {
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
				relayIssuer: "https://relay.test",
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
