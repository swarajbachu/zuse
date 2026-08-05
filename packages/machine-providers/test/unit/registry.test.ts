import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
	type MachineProviderAdapter,
	MachineProviders,
} from "../../src/index.ts";

const adapter = (providerId: string): MachineProviderAdapter => ({
	providerId,
	create: () => Effect.die("unused"),
	recoverByLabel: () => Effect.succeed(null),
	inspect: () => Effect.succeed(null),
	powerOff: () => Effect.void,
	powerOn: () => Effect.void,
	snapshot: () => Effect.die("unused"),
	delete: () => Effect.void,
	deleteSnapshot: () => Effect.void,
});

describe("machine provider registry", () => {
	test("selects the default and preserves per-record provider routing", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const providers = yield* MachineProviders;
				return {
					defaultProvider: (yield* providers.getDefault).providerId,
					existingProvider: (yield* providers.get("provider-a")).providerId,
					missing: yield* providers.get("missing").pipe(Effect.flip),
				};
			}).pipe(
				Effect.provide(
					MachineProviders.layer({
						registrations: [
							{ adapter: adapter("provider-a") },
							{ adapter: adapter("provider-b") },
						],
						defaultProviderId: "provider-b",
					}).pipe(Layer.orDie),
				),
			),
		);

		expect(result.defaultProvider).toBe("provider-b");
		expect(result.existingProvider).toBe("provider-a");
		expect(result.missing.providerId).toBe("missing");
	});

	test("routes persisted provider aliases through the canonical adapter", async () => {
		const canonical = adapter("provider-current");
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const providers = yield* MachineProviders;
				return {
					providerIds: providers.providerIds,
					defaultProvider: (yield* providers.getDefault).providerId,
					legacyProvider: (yield* providers.get("provider-legacy")).providerId,
				};
			}).pipe(
				Effect.provide(
					MachineProviders.layer({
						registrations: [
							{
								adapter: canonical,
								aliases: ["provider-legacy"],
							},
						],
						defaultProviderId: canonical.providerId,
					}).pipe(Layer.orDie),
				),
			),
		);

		expect(result).toEqual({
			providerIds: ["provider-current", "provider-legacy"],
			defaultProvider: "provider-current",
			legacyProvider: "provider-legacy",
		});
	});
});
