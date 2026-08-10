import { SandboxProviders } from "@zuse/sandbox-providers";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import {
	resolveSandboxProviderRuntime,
	SandboxProviderConfigurationError,
} from "../../src/sandbox-provider-config.ts";

const configuredEnvironment = {
	E2B_ADAPTER_ENABLED: "true",
	E2B_API_KEY: "secret",
	E2B_API_BASE_URL: "https://sandbox.test",
	E2B_TEMPLATE_ID: "zuse-sandbox",
	E2B_TEMPLATE_VERSION: "build-4",
} as const;

describe("sandbox provider configuration", () => {
	test("defaults to a fake provider and a stable offer configuration", async () => {
		const runtime = resolveSandboxProviderRuntime({});
		const providerId = await Effect.runPromise(
			Effect.gen(function* () {
				return (yield* (yield* SandboxProviders).getDefault).providerId;
			}).pipe(Effect.provide(runtime.layer)),
		);

		expect(runtime.configuredProviders).toEqual([]);
		expect(runtime.offer).toMatchObject({
			port: 47_837,
			createTimeoutSeconds: 3_600,
			keepAliveTimeoutSeconds: 3_600,
		});
		expect(providerId).toBe("fake");
	});

	test("fails closed when an enabled provider is incomplete", () => {
		expect(() =>
			resolveSandboxProviderRuntime({ E2B_ADAPTER_ENABLED: "true" }),
		).toThrow(SandboxProviderConfigurationError);
	});

	test("loads a complete live provider without marking it production ready", async () => {
		const runtime = resolveSandboxProviderRuntime(configuredEnvironment);
		const providers = await Effect.runPromise(
			Effect.gen(function* () {
				const registry = yield* SandboxProviders;
				return {
					defaultProviderId: (yield* registry.getDefault).providerId,
					availableProviderIds: registry.availableProviders.map(
						(provider) => provider.providerId,
					),
					templateVersion: registry.availableProviders[0]?.templateVersion,
				};
			}).pipe(Effect.provide(runtime.layer)),
		);

		expect(runtime.configuredProviders).toEqual([
			{ providerId: "e2b", productionReady: false },
		]);
		expect(providers).toEqual({
			defaultProviderId: "fake",
			availableProviderIds: ["e2b"],
			templateVersion: "build-4",
		});
	});
});
