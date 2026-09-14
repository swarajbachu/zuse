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
			keepAliveTimeoutSeconds: 600,
		});
		expect(providerId).toBe("fake");
	});

	test("fails closed when an enabled provider is incomplete", () => {
		expect(() =>
			resolveSandboxProviderRuntime({ E2B_ADAPTER_ENABLED: "true" }),
		).toThrow(SandboxProviderConfigurationError);
	});

	test("keeps E2B available internally without advertising new workspaces", async () => {
		const runtime = resolveSandboxProviderRuntime(configuredEnvironment);
		const providers = await Effect.runPromise(
			Effect.gen(function* () {
				const registry = yield* SandboxProviders;
				return {
					defaultProviderId: (yield* registry.getDefault).providerId,
					availableProviderIds: registry.availableProviders.map(
						(provider) => provider.providerId,
					),
					templateVersion: (yield* registry.get("e2b")).templateVersion,
				};
			}).pipe(Effect.provide(runtime.layer)),
		);

		expect(runtime.configuredProviders).toEqual([
			{ providerId: "e2b", productionReady: true, advertised: false },
		]);
		expect(providers).toEqual({
			defaultProviderId: "e2b",
			availableProviderIds: [],
			templateVersion: "build-4",
		});
	});

	test("honors an explicit default provider selection", async () => {
		const runtime = resolveSandboxProviderRuntime({
			...configuredEnvironment,
			SANDBOX_DEFAULT_PROVIDER_ID: "e2b",
		});
		const defaultProviderId = await Effect.runPromise(
			Effect.gen(function* () {
				return (yield* (yield* SandboxProviders).getDefault).providerId;
			}).pipe(Effect.provide(runtime.layer)),
		);

		expect(defaultProviderId).toBe("e2b");
	});

	test("fails closed when the default provider is not configured", () => {
		expect(() =>
			resolveSandboxProviderRuntime({
				...configuredEnvironment,
				SANDBOX_DEFAULT_PROVIDER_ID: "missing",
			}),
		).toThrow(SandboxProviderConfigurationError);
	});

	test("defaults new workspaces to Box while keeping E2B for authentication", async () => {
		const runtime = resolveSandboxProviderRuntime({
			...configuredEnvironment,
			BOX_ADAPTER_ENABLED: "true",
			BOX_API_KEY: "box-secret",
			BOX_TEMPLATE_SNAPSHOT: "zuse-base-v1",
			BOX_TEMPLATE_VERSION: "v1",
		});
		const providers = await Effect.runPromise(
			Effect.gen(function* () {
				const registry = yield* SandboxProviders;
				return {
					defaultProviderId: (yield* registry.getDefault).providerId,
					availableProviderIds: registry.availableProviders.map(
						(provider) => provider.providerId,
					),
					boxResources: (yield* registry.get("box")).resources,
				};
			}).pipe(Effect.provide(runtime.layer)),
		);

		expect(runtime.configuredProviders).toEqual([
			{ providerId: "e2b", productionReady: true, advertised: false },
			{ providerId: "box", productionReady: false, advertised: true },
		]);
		expect(providers).toEqual({
			defaultProviderId: "box",
			availableProviderIds: ["box"],
			boxResources: { vcpuCount: 2, memoryMib: 4_096 },
		});
	});

	test("fails closed when an enabled Box provider is incomplete", () => {
		expect(() =>
			resolveSandboxProviderRuntime({ BOX_ADAPTER_ENABLED: "true" }),
		).toThrow(SandboxProviderConfigurationError);
	});
});
