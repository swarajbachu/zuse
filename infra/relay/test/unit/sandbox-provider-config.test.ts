import { SandboxProviders } from "@zuse/sandbox-providers";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import {
	resolveSandboxProviderRuntime,
	SandboxProviderConfigurationError,
} from "../../src/sandbox-provider-config.ts";

const configuredEnvironment = {
	SANDBOX_PROVIDER: "e2b",
	E2B_ADAPTER_ENABLED: "true",
	E2B_API_KEY: "secret",
	E2B_API_BASE_URL: "https://sandbox.test",
	E2B_TEMPLATE_ID: "zuse-sandbox",
} as const;

describe("sandbox provider configuration", () => {
	test("defaults to a fake provider and a stable offer configuration", async () => {
		const runtime = resolveSandboxProviderRuntime({});
		const providerId = await Effect.runPromise(
			Effect.gen(function* () {
				return (yield* (yield* SandboxProviders).getDefault).providerId;
			}).pipe(Effect.provide(runtime.layer)),
		);

		expect(runtime.providerId).toBe("fake");
		expect(runtime.productionReady).toBe(false);
		expect(runtime.offer).toMatchObject({
			port: 47_837,
			createTimeoutSeconds: 86_400,
			keepAliveTimeoutSeconds: 86_400,
		});
		expect(providerId).toBe("fake");
	});

	test("fails closed when the selected live provider is incomplete", () => {
		expect(() =>
			resolveSandboxProviderRuntime({ SANDBOX_PROVIDER: "e2b" }),
		).toThrow(SandboxProviderConfigurationError);
	});

	test("loads a complete live provider without marking it production ready", async () => {
		const runtime = resolveSandboxProviderRuntime(configuredEnvironment);
		const providerId = await Effect.runPromise(
			Effect.gen(function* () {
				return (yield* (yield* SandboxProviders).getDefault).providerId;
			}).pipe(Effect.provide(runtime.layer)),
		);

		expect(runtime.providerId).toBe("e2b");
		expect(runtime.productionReady).toBe(false);
		expect(runtime.offer.templateId).toBe("zuse-sandbox");
		expect(providerId).toBe("e2b");
	});
});
