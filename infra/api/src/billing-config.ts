import {
	BillingProviderManual,
	BillingProviders,
} from "@zuse/billing-providers";
import {
	makePolarBillingProvider,
	type PolarBillingConfig,
} from "@zuse/billing-providers/polar";
import {
	makeStripeBillingProvider,
	type StripeBillingStore,
} from "@zuse/billing-providers/stripe";
import { resolveStripeCloudBillingMode } from "@zuse/billing-providers/stripe-billing-mode";
import { stripeKeyEnvironment } from "@zuse/billing-providers/stripe-key";
import { Layer, Redacted } from "effect";
import { isConfigured } from "./environment.ts";

export interface BillingEnvironment {
	readonly BILLING_DEFAULT_PROVIDER?: string;
	readonly STRIPE_SECRET_KEY?: string;
	readonly STRIPE_ENVIRONMENT?: string;
	readonly STRIPE_WEBHOOK_SECRET?: string;
	readonly STRIPE_PRICE_CLOUD_WORKSPACE_STANDARD_V1?: string;
	readonly STRIPE_PRICE_PERSISTENT_STANDARD_V1?: string;
	readonly STRIPE_CLOUD_OVERAGE_PRICE_ID?: string;
	readonly STRIPE_CLOUD_OVERAGE_METER_ID?: string;
	readonly STRIPE_PORTAL_CONFIGURATION_ID?: string;
	readonly STRIPE_PREPAID_CREDIT_PRICE_ID?: string;
	readonly STRIPE_AUTOMATIC_TAX_ENABLED?: string;
	readonly STRIPE_CLOUD_BILLING_MODE?: string;
	readonly API_ISSUER?: string;
	readonly MACHINE_LIVE_CHECKOUT_ENABLED?: string;
	readonly MACHINE_SALES_APPROVED?: string;
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
	readonly stripeConfigured: boolean;
	readonly defaultProviderId: string;
	readonly sandboxMode: boolean;
	readonly cloudCheckoutConfigured: boolean;
	readonly persistentCheckoutConfigured: boolean;
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

/** Store injection is supplied by the Worker SQL layer. Config-only callers
 * can inspect registration without opening a database connection. */
const unavailableStore: StripeBillingStore = {
	claimCustomerRecoveries: async () => {
		throw new Error("stripe_store_unavailable");
	},
	finishCustomerRecovery: async () => {
		throw new Error("stripe_store_unavailable");
	},
	getCustomer: async () => {
		throw new Error("stripe_store_unavailable");
	},
	reserveCustomer: async () => {
		throw new Error("stripe_store_unavailable");
	},
	renewCustomerReservation: async () => {
		throw new Error("stripe_store_unavailable");
	},
	linkCustomer: async () => {
		throw new Error("stripe_store_unavailable");
	},
	claimDelivery: async () => {
		throw new Error("stripe_store_unavailable");
	},
	finishDelivery: async () => {
		throw new Error("stripe_store_unavailable");
	},
};
export const resolveBillingRuntime = (
	env: BillingEnvironment,
	stripeStore: StripeBillingStore = unavailableStore,
): BillingRuntime => {
	const cloudBillingMode = resolveStripeCloudBillingMode(
		env.STRIPE_CLOUD_BILLING_MODE,
	);
	const config = polarConfig(env);
	const stripeConfigured =
		isConfigured(env.STRIPE_SECRET_KEY) &&
		isConfigured(env.STRIPE_WEBHOOK_SECRET) &&
		(isConfigured(env.STRIPE_PRICE_CLOUD_WORKSPACE_STANDARD_V1) ||
			isConfigured(env.STRIPE_PRICE_PERSISTENT_STANDARD_V1));
	if (
		stripeConfigured &&
		((env.STRIPE_ENVIRONMENT === "production" &&
			stripeKeyEnvironment(env.STRIPE_SECRET_KEY) !== "production") ||
			(env.STRIPE_ENVIRONMENT === "sandbox" &&
				stripeKeyEnvironment(env.STRIPE_SECRET_KEY) !== "sandbox"))
	)
		throw new Error("stripe_environment_key_mismatch");
	const adapters = [BillingProviderManual];
	if (config) adapters.push(makePolarBillingProvider(config));
	if (stripeConfigured)
		adapters.push(
			makeStripeBillingProvider(
				{
					secretKey: Redacted.make(env.STRIPE_SECRET_KEY ?? ""),
					webhookSecret: Redacted.make(env.STRIPE_WEBHOOK_SECRET ?? ""),
					offerPrices: {
						...(isConfigured(env.STRIPE_PRICE_CLOUD_WORKSPACE_STANDARD_V1)
							? {
									"cloud-workspace-standard-v1":
										env.STRIPE_PRICE_CLOUD_WORKSPACE_STANDARD_V1,
								}
							: {}),
						...(isConfigured(env.STRIPE_PRICE_PERSISTENT_STANDARD_V1)
							? {
									"persistent-standard-v1":
										env.STRIPE_PRICE_PERSISTENT_STANDARD_V1,
								}
							: {}),
					},
					cloudOveragePriceId: isConfigured(env.STRIPE_CLOUD_OVERAGE_PRICE_ID)
						? env.STRIPE_CLOUD_OVERAGE_PRICE_ID
						: undefined,
					portalReturnUrl: env.API_ISSUER ?? "https://api.zuse.sh",
					portalConfigurationId: env.STRIPE_PORTAL_CONFIGURATION_ID,
					prepaidCreditPriceId: env.STRIPE_PREPAID_CREDIT_PRICE_ID,
					automaticTaxEnabled: env.STRIPE_AUTOMATIC_TAX_ENABLED !== "false",
					cloudBillingMode,
				},
				{ store: stripeStore },
			),
		);
	const defaultProviderId =
		env.BILLING_DEFAULT_PROVIDER ??
		(stripeConfigured ? "stripe" : config ? "polar" : "manual");
	if (!adapters.some((adapter) => adapter.providerId === defaultProviderId))
		throw new Error("configured_default_billing_provider_unavailable");
	// Missing overage configuration must never silently sell a cloud plan
	// whose usage cannot be invoiced.
	const canCheckout =
		defaultProviderId !== "manual" &&
		!(
			defaultProviderId === "stripe" &&
			cloudBillingMode === "metered" &&
			isConfigured(env.STRIPE_PRICE_CLOUD_WORKSPACE_STANDARD_V1) &&
			(!isConfigured(env.STRIPE_CLOUD_OVERAGE_PRICE_ID) ||
				!isConfigured(env.STRIPE_CLOUD_OVERAGE_METER_ID))
		);
	return {
		layer: BillingProviders.layer({ adapters, defaultProviderId }).pipe(
			Layer.orDie,
		),
		liveCheckoutEnabled:
			env.MACHINE_LIVE_CHECKOUT_ENABLED === "true" && canCheckout,
		polarConfigured: config !== undefined,
		stripeConfigured,
		defaultProviderId,
		persistentCheckoutConfigured:
			defaultProviderId === "stripe"
				? isConfigured(env.STRIPE_PRICE_PERSISTENT_STANDARD_V1)
				: isConfigured(env.POLAR_PRODUCT_PERSISTENT_STANDARD_V1),
		sandboxMode:
			defaultProviderId === "stripe"
				? stripeKeyEnvironment(env.STRIPE_SECRET_KEY) === "sandbox"
				: env.POLAR_ENVIRONMENT === "sandbox",
		cloudCheckoutConfigured:
			defaultProviderId === "stripe"
				? isConfigured(env.STRIPE_PRICE_CLOUD_WORKSPACE_STANDARD_V1)
				: isConfigured(
						env.POLAR_PRODUCT_CLOUD_WORKSPACE_STANDARD_V1 ??
							env.POLAR_PRODUCT_SANDBOX_STANDARD_V1,
					),
	};
};
