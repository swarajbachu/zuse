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

describe("api billing configuration", () => {
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
					successUrl: "https://api.test/complete",
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

const stripeEnvironment = {
	STRIPE_SECRET_KEY: "sk_test_example",
	STRIPE_WEBHOOK_SECRET: "whsec_example",
	STRIPE_PRICE_CLOUD_WORKSPACE_STANDARD_V1: "price_cloud",
	STRIPE_CLOUD_OVERAGE_PRICE_ID: "price_overage",
	STRIPE_CLOUD_OVERAGE_METER_ID: "meter_overage",
	MACHINE_LIVE_CHECKOUT_ENABLED: "true",
};
test("explicit subscription-only Stripe checkout does not require an overage price", () => {
	const runtime = resolveBillingRuntime({
		...configuredEnvironment,
		...stripeEnvironment,
		STRIPE_CLOUD_BILLING_MODE: "subscription-only",
		STRIPE_CLOUD_OVERAGE_PRICE_ID: undefined,
		STRIPE_CLOUD_OVERAGE_METER_ID: undefined,
	});
	expect(runtime.defaultProviderId).toBe("stripe");
	expect(runtime.liveCheckoutEnabled).toBe(true);
	expect(runtime.polarConfigured).toBe(true);
});
test("rejects an invalid Stripe cloud billing mode", () => {
	expect(() =>
		resolveBillingRuntime({
			...stripeEnvironment,
			STRIPE_CLOUD_BILLING_MODE: "unknown",
		}),
	).toThrow("invalid_stripe_cloud_billing_mode");
});
test("Stripe becomes checkout default while preserving Polar adapters", async () => {
	const runtime = resolveBillingRuntime({
		...configuredEnvironment,
		...stripeEnvironment,
	});
	const providers = await Effect.runPromise(
		BillingProviders.pipe(Effect.provide(runtime.layer)),
	);
	expect(providers.providerIds).toEqual(["manual", "polar", "stripe"]);
	expect(providers.defaultProviderId).toBe("stripe");
	expect(runtime.liveCheckoutEnabled).toBe(true);
});
test("explicit checkout rollback keeps Stripe registered for existing subscriptions", async () => {
	const runtime = resolveBillingRuntime({
		...configuredEnvironment,
		...stripeEnvironment,
		BILLING_DEFAULT_PROVIDER: "polar",
	});
	const providers = await Effect.runPromise(
		BillingProviders.pipe(Effect.provide(runtime.layer)),
	);
	expect(providers.defaultProviderId).toBe("polar");
	expect(providers.providerIds).toContain("stripe");
});
test("fails closed for an unavailable explicitly selected provider", () => {
	expect(() =>
		resolveBillingRuntime({
			...configuredEnvironment,
			BILLING_DEFAULT_PROVIDER: "stripe",
		}),
	).toThrow("configured_default_billing_provider_unavailable");
});
test("does not sell Stripe cloud subscriptions without overage configuration", () => {
	expect(
		resolveBillingRuntime({
			...stripeEnvironment,
			STRIPE_CLOUD_OVERAGE_PRICE_ID: undefined,
		}).liveCheckoutEnabled,
	).toBe(false);
	expect(
		resolveBillingRuntime({
			...stripeEnvironment,
			STRIPE_CLOUD_OVERAGE_METER_ID: undefined,
		}).liveCheckoutEnabled,
	).toBe(false);
});

test("offer readiness and sandbox placement follow the selected Stripe provider", () => {
	const runtime = resolveBillingRuntime({
		...configuredEnvironment,
		...stripeEnvironment,
		POLAR_ENVIRONMENT: "production",
	});
	expect(runtime.sandboxMode).toBe(true);
	expect(runtime.cloudCheckoutConfigured).toBe(true);
	expect(runtime.persistentCheckoutConfigured).toBe(false);
	expect(
		resolveBillingRuntime({
			...stripeEnvironment,
			STRIPE_PRICE_PERSISTENT_STANDARD_V1: "price_machine",
		}).persistentCheckoutConfigured,
	).toBe(true);
	expect(() =>
		resolveBillingRuntime({
			...stripeEnvironment,
			STRIPE_ENVIRONMENT: "production",
		}),
	).toThrow("stripe_environment_key_mismatch");
});

test.each([
	["rk_live_example", "production", false],
	["rk_test_example", "sandbox", true],
] as const)("accepts scoped Stripe keys %s with matching mode", (key, environment, sandboxMode) => {
	const runtime = resolveBillingRuntime({
		...stripeEnvironment,
		STRIPE_SECRET_KEY: key,
		STRIPE_ENVIRONMENT: environment,
	});
	expect(runtime.stripeConfigured).toBe(true);
	expect(runtime.sandboxMode).toBe(sandboxMode);
	expect(() =>
		resolveBillingRuntime({
			...stripeEnvironment,
			STRIPE_SECRET_KEY: key,
			STRIPE_ENVIRONMENT:
				environment === "production" ? "sandbox" : "production",
		}),
	).toThrow("stripe_environment_key_mismatch");
});
