import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
	type SandboxProviderAdapter,
	SandboxProviders,
} from "../../src/index.ts";

const adapter = (providerId: string): SandboxProviderAdapter => ({
	providerId,
	displayName: providerId,
	templateVersion: "test-template",
	create: () => Effect.die("unused"),
	fork: () => Effect.die("unused"),
	recoverByLabel: () => Effect.succeed(null),
	startProcess: () => Effect.void,
	replaceProcess: () => Effect.void,
	pathExists: () => Effect.succeed(false),
	readTextFile: () => Effect.succeed(""),
	writeTextFile: () => Effect.void,
	inspect: () => Effect.succeed(null),
	resolveEndpoint: () => Effect.die("unused"),
	pause: () => Effect.void,
	resume: () => Effect.die("unused"),
	extendTimeout: () => Effect.void,
	setNetwork: () => Effect.void,
	snapshot: () => Effect.die("unused"),
	kill: () => Effect.void,
	deleteSnapshot: () => Effect.void,
});

describe("sandbox provider registry", () => {
	test("selects the default and preserves per-record provider routing", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const providers = yield* SandboxProviders;
				return {
					defaultProvider: (yield* providers.getDefault).providerId,
					existingProvider: (yield* providers.get("provider-a")).providerId,
					missing: yield* providers.get("missing").pipe(Effect.flip),
				};
			}).pipe(
				Effect.provide(
					SandboxProviders.layer({
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
				const providers = yield* SandboxProviders;
				return {
					providerIds: providers.providerIds,
					availableProviderIds: providers.availableProviders.map(
						(provider) => provider.providerId,
					),
					defaultProvider: (yield* providers.getDefault).providerId,
					legacyProvider: (yield* providers.get("provider-legacy")).providerId,
				};
			}).pipe(
				Effect.provide(
					SandboxProviders.layer({
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
			availableProviderIds: ["provider-current"],
			defaultProvider: "provider-current",
			legacyProvider: "provider-legacy",
		});
	});
});
