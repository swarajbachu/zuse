import { BillingProviders } from "@zuse/billing-providers";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { resolveBillingRuntime } from "../../src/billing-config.ts";

const configuredEnvironment = {
	MACHINE_LIVE_CHECKOUT_ENABLED: "true",
	POLAR_ACCESS_TOKEN: "polar_test_token",
	POLAR_ENVIRONMENT: "sandbox",
	POLAR_PRODUCT_CLOUD_WORKSPACE_STANDARD_V1: "product_cloud_workspace",
	POLAR_PRODUCT_PERSISTENT_STANDARD_V1: "product_machine",
	POLAR_VPS_SALES_APPROVED: "false",
	POLAR_WEBHOOK_SECRET: "polar_webhook_secret",
};

describe("relay billing configuration", () => {
	test("falls back to manual billing when Polar is incomplete", async () => {
		const runtime = resolveBillingRuntime({
			...configuredEnvironment,
			POLAR_WEBHOOK_SECRET: undefined,
		});
		const providers = await Effect.runPromise(
			BillingProviders.pipe(Effect.provide(runtime.layer)),
		);

		expect(runtime.polarConfigured).toBe(false);
		expect(runtime.liveCheckoutEnabled).toBe(false);
		expect(providers.providerIds).toEqual(["manual"]);
		expect(providers.defaultProviderId).toBe("manual");
	});

	test("registers Polar without enabling checkout before sales approval", async () => {
		const runtime = resolveBillingRuntime({
			...configuredEnvironment,
			MACHINE_LIVE_CHECKOUT_ENABLED: "false",
		});
		const providers = await Effect.runPromise(
			BillingProviders.pipe(Effect.provide(runtime.layer)),
		);

		expect(runtime.polarConfigured).toBe(true);
		expect(runtime.liveCheckoutEnabled).toBe(false);
		expect(providers.providerIds).toEqual(["manual", "polar"]);
		expect(providers.defaultProviderId).toBe("polar");
	});

	test("enables configured checkout independently of VPS sales approval", () => {
		expect(
			resolveBillingRuntime(configuredEnvironment).liveCheckoutEnabled,
		).toBe(true);
		expect(
			resolveBillingRuntime({
				...configuredEnvironment,
				POLAR_ENVIRONMENT: "production",
			}).liveCheckoutEnabled,
		).toBe(true);
		expect(
			resolveBillingRuntime({
				...configuredEnvironment,
				POLAR_ENVIRONMENT: "production",
				MACHINE_LIVE_CHECKOUT_ENABLED: "false",
			}).liveCheckoutEnabled,
		).toBe(false);
	});

	test("maps the optional cloud workspace subscription product", async () => {
		const runtime = resolveBillingRuntime(configuredEnvironment);
		const billing = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* (yield* BillingProviders).getDefault;
			}).pipe(Effect.provide(runtime.layer)),
		);

		await expect(
			Effect.runPromise(
				billing.checkout({
					accountId: "user_a",
					offerId: "cloud-workspace-standard-v1",
					successUrl: "https://relay.test/complete",
				}),
			),
		).rejects.not.toMatchObject({ code: "invalid-offer" });
	});

	test("configures cloud billing without the unrelated machine product", () => {
		const runtime = resolveBillingRuntime({
			...configuredEnvironment,
			POLAR_PRODUCT_PERSISTENT_STANDARD_V1: undefined,
		});

		expect(runtime.polarConfigured).toBe(true);
	});

	test("accepts the legacy cloud workspace product variable during rollout", async () => {
		const {
			POLAR_PRODUCT_CLOUD_WORKSPACE_STANDARD_V1: _,
			...legacyEnvironment
		} = configuredEnvironment;
		const runtime = resolveBillingRuntime({
			...legacyEnvironment,
			POLAR_PRODUCT_SANDBOX_STANDARD_V1: "legacy_product",
		});
		expect(runtime.polarConfigured).toBe(true);
	});
});
