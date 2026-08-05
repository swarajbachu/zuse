import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
	type BillingProviderAdapter,
	BillingProviders,
} from "../../src/index.ts";

const adapter = (providerId: string): BillingProviderAdapter => ({
	providerId,
	checkout: () => Effect.succeed(`${providerId}:checkout`),
	verifyEvent: () => Effect.die("unused"),
	reconcileSubscription: () => Effect.die("unused"),
	cancel: () => Effect.void,
	customerPortal: () => Effect.succeed(`${providerId}:portal`),
});

describe("billing provider registry", () => {
	test("selects defaults without changing existing subscription routing", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const providers = yield* BillingProviders;
				return {
					defaultProvider: (yield* providers.getDefault).providerId,
					existingProvider: (yield* providers.get("billing-a")).providerId,
				};
			}).pipe(
				Effect.provide(
					BillingProviders.layer({
						adapters: [adapter("billing-a"), adapter("billing-b")],
						defaultProviderId: "billing-b",
					}).pipe(Layer.orDie),
				),
			),
		);

		expect(result.defaultProvider).toBe("billing-b");
		expect(result.existingProvider).toBe("billing-a");
	});
});
