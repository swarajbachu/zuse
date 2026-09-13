import {
	BillingProviderManual,
	BillingProviders,
	BillingProvidersManual,
} from "@zuse/billing-providers";
import {
	makePolarBillingProvider,
	type PolarBillingConfig,
} from "@zuse/billing-providers/polar";
import { Layer, Redacted } from "effect";
import { isConfigured } from "./environment.ts";

export interface BillingEnvironment {
	readonly MACHINE_LIVE_CHECKOUT_ENABLED?: string;
	readonly POLAR_ACCESS_TOKEN?: string;
	readonly POLAR_ENVIRONMENT?: string;
	readonly POLAR_PRODUCT_CLOUD_WORKSPACE_STANDARD_V1?: string;
	readonly POLAR_PRODUCT_PERSISTENT_STANDARD_V1?: string;
	/** @deprecated Use POLAR_PRODUCT_CLOUD_WORKSPACE_STANDARD_V1. */
	readonly POLAR_PRODUCT_SANDBOX_STANDARD_V1?: string;
	readonly POLAR_VPS_SALES_APPROVED?: string;
	readonly POLAR_WEBHOOK_SECRET?: string;
	readonly POLAR_CLOUD_OVERAGE_METER_ID?: string;
}

export interface BillingRuntime {
	readonly layer: Layer.Layer<BillingProviders>;
	readonly liveCheckoutEnabled: boolean;
	readonly polarConfigured: boolean;
}

const polarConfig = (
	env: BillingEnvironment,
): PolarBillingConfig | undefined => {
	const cloudProduct =
		env.POLAR_PRODUCT_CLOUD_WORKSPACE_STANDARD_V1 ??
		env.POLAR_PRODUCT_SANDBOX_STANDARD_V1;
	const offerProducts = {
		...(isConfigured(env.POLAR_PRODUCT_PERSISTENT_STANDARD_V1)
			? {
					"persistent-standard-v1": env.POLAR_PRODUCT_PERSISTENT_STANDARD_V1,
				}
			: {}),
		...(isConfigured(cloudProduct)
			? { "cloud-workspace-standard-v1": cloudProduct }
			: {}),
	};
	if (
		!isConfigured(env.POLAR_ACCESS_TOKEN) ||
		!isConfigured(env.POLAR_WEBHOOK_SECRET) ||
		Object.keys(offerProducts).length === 0 ||
		(env.POLAR_ENVIRONMENT !== "sandbox" &&
			env.POLAR_ENVIRONMENT !== "production")
	) {
		return undefined;
	}
	return {
		accessToken: Redacted.make(env.POLAR_ACCESS_TOKEN),
		webhookSecret: Redacted.make(env.POLAR_WEBHOOK_SECRET),
		environment: env.POLAR_ENVIRONMENT,
		offerProducts,
		...(isConfigured(env.POLAR_CLOUD_OVERAGE_METER_ID)
			? { overageMeterId: env.POLAR_CLOUD_OVERAGE_METER_ID }
			: {}),
	};
};

export const resolveBillingRuntime = (
	env: BillingEnvironment,
): BillingRuntime => {
	const config = polarConfig(env);
	if (config === undefined) {
		return {
			layer: BillingProvidersManual,
			liveCheckoutEnabled: false,
			polarConfigured: false,
		};
	}
	const polar = makePolarBillingProvider(config);
	return {
		layer: BillingProviders.layer({
			adapters: [BillingProviderManual, polar],
			defaultProviderId: polar.providerId,
		}).pipe(Layer.orDie),
		liveCheckoutEnabled: env.MACHINE_LIVE_CHECKOUT_ENABLED === "true",
		polarConfigured: true,
	};
};
