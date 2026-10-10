import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { applyEdits, modify, parse } from "jsonc-parser";
import Stripe from "stripe";
import { resolveStripeCloudBillingMode } from "../../../packages/billing-providers/src/stripe-billing-mode.ts";
import { stripeKeyEnvironment } from "../../../packages/billing-providers/src/stripe-key.ts";

export const webhookEvents = [
	"customer.subscription.created",
	"customer.subscription.updated",
	"customer.subscription.deleted",
	"customer.subscription.paused",
	"customer.subscription.resumed",
	"invoice.paid",
	"invoice.payment_failed",
	"checkout.session.completed",
	"checkout.session.async_payment_succeeded",
	"charge.refunded",
	"refund.updated",
	"charge.dispute.funds_withdrawn",
	"charge.dispute.funds_reinstated",
];
export const webhookUrl = "https://api.zuse.sh/v1/billing/webhook/stripe";
export function assertStripeProductionBillingGates(vars) {
	const mode = resolveStripeCloudBillingMode(vars.STRIPE_CLOUD_BILLING_MODE);
	if (vars.BILLING_DEFAULT_PROVIDER !== "stripe") return;
	if (mode === "subscription-only") {
		assert(
			vars.CLOUD_BILLING_EXPORT_ENABLED === "false" &&
				vars.CLOUD_BILLING_ENFORCEMENT_ENABLED === "false",
			"Subscription-only Stripe checkout requires usage charging and enforcement to stay explicitly disabled",
		);
		return;
	}
	assert(
		vars.CLOUD_BILLING_EXPORT_ENABLED === "true" &&
			vars.CLOUD_BILLING_ENFORCEMENT_ENABLED === "true",
		"Stripe production checkout requires overage export and spend-cap enforcement; verify provider settlement before enabling both gates",
	);
}
const configPath = fileURLToPath(
	new URL("../wrangler.production.jsonc", import.meta.url),
);
const defaultDirectory = fileURLToPath(
	new URL("../../../.context/stripe-production", import.meta.url),
);

export function productionVars(state) {
	assert(state.basePriceId && state.overagePriceId && state.meterId);
	return {
		STRIPE_ENVIRONMENT: "production",
		STRIPE_PRICE_CLOUD_WORKSPACE_STANDARD_V1: state.basePriceId,
		STRIPE_CLOUD_OVERAGE_PRICE_ID: state.overagePriceId,
		STRIPE_CLOUD_OVERAGE_METER_ID: state.meterId,
		...(state.prepaidPriceId
			? { STRIPE_PREPAID_CREDIT_PRICE_ID: state.prepaidPriceId }
			: {}),
		...(state.portalConfigurationId
			? { STRIPE_PORTAL_CONFIGURATION_ID: state.portalConfigurationId }
			: {}),
	};
}

// The private journal is persisted before each remote mutation. Retry the same
// payload and key after interruption; never recreate ambiguous old requests.
export async function provision(
	stripe,
	state,
	save,
	taxCode,
	now = Date.now(),
) {
	assert(
		!taxCode || taxCode.startsWith("txcd_"),
		"Use a verified Stripe product tax code",
	);
	const account = await stripe.accounts.retrieve();
	assert(
		account.charges_enabled,
		"Stripe account is not enabled to accept live payments",
	);
	assert(
		!state.accountId || state.accountId === account.id,
		"Setup belongs to another Stripe account",
	);
	assert(
		!state.taxCode || state.taxCode === taxCode,
		"Setup tax code cannot change during retry",
	);
	state.accountId = account.id;
	state.taxCode = taxCode;
	state.attempts ??= {};
	await save();
	async function create(name, params, operation) {
		const fingerprint = createHash("sha256")
			.update(JSON.stringify(params))
			.digest("hex");
		const previous = state.attempts[name];
		assert(
			!previous || previous.fingerprint === fingerprint,
			`Changed ${name} payload requires reconciliation`,
		);
		assert(
			!previous || now - previous.at < 23 * 3600000,
			`Ambiguous ${name} request is older than 23 hours; reconcile in Stripe before retry`,
		);
		state.attempts[name] ??= { at: now, fingerprint };
		await save();
		const object = await operation(params, {
			idempotencyKey: `zuse-production-v1-${account.id}-${name}`,
		});
		assert(object.livemode === true, "Stripe returned a non-live object");
		return object;
	}
	const meters = await stripe.billing.meters
		.list({ limit: 100 })
		.autoPagingToArray({ limit: 10000 });
	for (const [name, label] of [
		["zuse_cloud_overage_cent", "Zuse Cloud overage cents"],
		[
			"zuse_cloud_runtime_observed_ms",
			"Zuse Cloud observed runtime (informational)",
		],
		[
			"zuse_cloud_provider_cost_micros",
			"Zuse Cloud provider cost (informational)",
		],
	]) {
		const matches = meters.filter((m) => m.event_name === name);
		assert(
			matches.length <= 1,
			`Multiple meters for ${name}; reconcile manually`,
		);
		const meter =
			matches[0] ??
			(await create(
				name,
				{
					event_name: name,
					display_name: label,
					default_aggregation: { formula: "sum" },
					customer_mapping: {
						type: "by_id",
						event_payload_key: "stripe_customer_id",
					},
					value_settings: { event_payload_key: "value" },
				},
				stripe.billing.meters.create.bind(stripe.billing.meters),
			));
		assert(
			meter.livemode &&
				meter.status === "active" &&
				meter.default_aggregation.formula === "sum" &&
				meter.customer_mapping.type === "by_id" &&
				meter.customer_mapping.event_payload_key === "stripe_customer_id" &&
				meter.value_settings.event_payload_key === "value" &&
				!meter.event_time_window,
			`Incompatible meter ${name}`,
		);
		if (name === "zuse_cloud_overage_cent") state.meterId = meter.id;
		await save();
	}
	if (!state.productId) {
		const product = await create(
			"product",
			{
				name: "Zuse Cloud Workspace",
				...(taxCode ? { tax_code: taxCode } : {}),
				metadata: { zuse_offer: "cloud-workspace-standard-v1" },
			},
			stripe.products.create.bind(stripe.products),
		);
		state.productId = product.id;
		await save();
	}
	const product = await stripe.products.retrieve(state.productId);
	assert(
		product.livemode &&
			product.active &&
			(!taxCode || product.tax_code === taxCode),
		"Incompatible live product",
	);
	for (const [field, amount, usage] of [
		["basePriceId", 4000, "licensed"],
		["overagePriceId", 1, "metered"],
	]) {
		const params = {
			product: state.productId,
			currency: "usd",
			unit_amount: amount,
			tax_behavior: "exclusive",
			recurring: {
				interval: "month",
				usage_type: usage,
				...(usage === "metered" ? { meter: state.meterId } : {}),
			},
			lookup_key: `zuse_cloud_v1_${usage}`,
			metadata: { zuse_offer: "cloud-workspace-standard-v1" },
		};
		const existing = await stripe.prices.list({
			lookup_keys: [params.lookup_key],
			limit: 2,
		});
		assert(existing.data.length <= 1, "Ambiguous price lookup key");
		const price = state[field]
			? await stripe.prices.retrieve(state[field])
			: (existing.data[0] ??
				(await create(
					field,
					params,
					stripe.prices.create.bind(stripe.prices),
				)));
		assert(
			price.livemode &&
				price.active &&
				price.product === state.productId &&
				price.currency === "usd" &&
				price.unit_amount === amount &&
				price.tax_behavior === "exclusive" &&
				price.billing_scheme === "per_unit" &&
				price.recurring?.interval === "month" &&
				price.recurring.interval_count === 1 &&
				price.recurring.usage_type === usage &&
				(usage !== "metered" || price.recurring.meter === state.meterId),
			"Incompatible live price",
		);
		state[field] = price.id;
		await save();
	}
	const prepaidPrices = await stripe.prices.list({
		lookup_keys: ["zuse_prepaid_usd_v1"],
		limit: 2,
	});
	assert(prepaidPrices.data.length <= 1, "Ambiguous prepaid price lookup key");
	const existingPrepaid = prepaidPrices.data[0];
	if (!state.prepaidProductId) {
		if (existingPrepaid) {
			assert(
				typeof existingPrepaid.product === "string",
				"Invalid prepaid product",
			);
			state.prepaidProductId = existingPrepaid.product;
		} else {
			state.prepaidProductId = (
				await create(
					"prepaidProduct",
					{
						name: "Zuse prepaid credits",
						metadata: { zuse_billing: "prepaid-v1" },
					},
					stripe.products.create.bind(stripe.products),
				)
			).id;
		}
		await save();
	}
	const prepaidProduct = await stripe.products.retrieve(state.prepaidProductId);
	assert(
		prepaidProduct.livemode &&
			prepaidProduct.active &&
			prepaidProduct.metadata?.zuse_billing === "prepaid-v1",
		"Incompatible prepaid product",
	);
	const prepaidPrice = state.prepaidPriceId
		? await stripe.prices.retrieve(state.prepaidPriceId)
		: (existingPrepaid ??
			(await create(
				"prepaidPrice",
				{
					product: state.prepaidProductId,
					currency: "usd",
					unit_amount: 100,
					lookup_key: "zuse_prepaid_usd_v1",
					metadata: { zuse_billing: "prepaid-v1" },
				},
				stripe.prices.create.bind(stripe.prices),
			)));
	assert(
		prepaidPrice.livemode &&
			prepaidPrice.active &&
			prepaidPrice.product === state.prepaidProductId &&
			prepaidPrice.currency === "usd" &&
			prepaidPrice.unit_amount === 100 &&
			!prepaidPrice.recurring &&
			!prepaidPrice.transform_quantity &&
			prepaidPrice.billing_scheme === "per_unit",
		"Incompatible prepaid price",
	);
	state.prepaidPriceId = prepaidPrice.id;
	await save();

	if (!state.portalConfigurationId) {
		const portal = await create(
			"portal",
			{
				name: "Zuse billing",
				default_return_url: "https://zuse.sh",
				business_profile: {
					headline: "Manage your Zuse subscription",
					privacy_policy_url: "https://zuse.sh/privacy",
					terms_of_service_url: "https://zuse.sh/terms",
				},
				features: {
					customer_update: {
						enabled: true,
						allowed_updates: ["email", "address", "tax_id"],
					},
					invoice_history: { enabled: true },
					payment_method_update: { enabled: true },
					subscription_cancel: {
						enabled: true,
						mode: "at_period_end",
						proration_behavior: "none",
					},
					subscription_update: { enabled: false },
				},
				metadata: { zuse_billing: "v1" },
			},
			stripe.billingPortal.configurations.create.bind(
				stripe.billingPortal.configurations,
			),
		);
		state.portalConfigurationId = portal.id;
		await save();
	}
	const portal = await stripe.billingPortal.configurations.retrieve(
		state.portalConfigurationId,
	);
	assert(
		portal.livemode &&
			portal.active &&
			portal.features.invoice_history.enabled &&
			portal.features.payment_method_update.enabled &&
			portal.features.subscription_cancel.enabled &&
			portal.features.subscription_cancel.mode === "at_period_end" &&
			!portal.features.subscription_update.enabled,
		"Incompatible live portal",
	);
	if (!state.webhookId) {
		const endpoints = await stripe.webhookEndpoints
			.list({ limit: 100 })
			.autoPagingToArray({ limit: 10000 });
		assert(
			!endpoints.some((e) => e.url === webhookUrl),
			"An endpoint already exists; reconcile its ID and signing secret instead of creating a duplicate",
		);
		const endpoint = await create(
			"webhook",
			{
				url: webhookUrl,
				api_version: Stripe.API_VERSION,
				enabled_events: webhookEvents,
				description: "Zuse production billing",
			},
			stripe.webhookEndpoints.create.bind(stripe.webhookEndpoints),
		);
		assert(endpoint.secret, "Webhook creation returned no signing secret");
		state.webhookId = endpoint.id;
		state.webhookSecret = endpoint.secret;
		await save();
	}
	let endpoint = await stripe.webhookEndpoints.retrieve(state.webhookId);
	assert(
		endpoint.livemode &&
			endpoint.status === "enabled" &&
			endpoint.url === webhookUrl &&
			endpoint.api_version === Stripe.API_VERSION,
		"Incompatible live webhook",
	);
	if (
		!webhookEvents.every((event) => endpoint.enabled_events.includes(event))
	) {
		endpoint = await create(
			"webhookPrepaidV1",
			{
				enabled_events: [
					...new Set([...endpoint.enabled_events, ...webhookEvents]),
				].sort(),
			},
			(params, options) =>
				stripe.webhookEndpoints.update(state.webhookId, params, options),
		);
	}
	assert(
		endpoint.livemode &&
			endpoint.status === "enabled" &&
			endpoint.url === webhookUrl &&
			endpoint.api_version === Stripe.API_VERSION &&
			webhookEvents.every((e) => endpoint.enabled_events.includes(e)),
		"Incompatible live webhook",
	);
	assert(
		state.webhookSecret?.startsWith("whsec_"),
		"Recover the existing webhook signing secret before installing",
	);
	return productionVars(state);
}

async function main() {
	const command = process.argv[2] ?? "plan";
	assert(
		["plan", "prepare", "install-secrets"].includes(command),
		"Usage: stripe-production-setup.mjs plan | prepare | install-secrets",
	);
	if (command === "plan") {
		const config = parse(await readFile(configPath, "utf8"));
		console.log(
			JSON.stringify(
				{
					mode: "read-only",
					checkoutProvider: config.vars.BILLING_DEFAULT_PROVIDER,
					webhookUrl,
					monthlyBaseCents: 4000,
					overageUnitCents: 1,
					livePricesConfigured: Boolean(
						config.vars.STRIPE_PRICE_CLOUD_WORKSPACE_STANDARD_V1 &&
							config.vars.STRIPE_CLOUD_OVERAGE_PRICE_ID,
					),
					next: [
						"Supply STRIPE_SECRET_KEY (sk_live_ or rk_live_) or STRIPE_LIVE_KEY_FILE and verified STRIPE_PRODUCT_TAX_CODE",
						"Run prepare to create/reuse live resources and write production IDs",
						"Run install-secrets to install both Stripe secrets into zuse-relay",
						"Apply database migrations 0040 and 0041 using the guarded production migration command",
						"Verify real business tax registrations, portal, retries, invoice grace period and provider settlement",
						"Deploy with Polar retained; verify live webhook delivery before switching checkout and billing gates",
					],
				},
				null,
				2,
			),
		);
		return;
	}
	const key =
		process.env.STRIPE_SECRET_KEY ??
		(process.env.STRIPE_LIVE_KEY_FILE
			? (await readFile(process.env.STRIPE_LIVE_KEY_FILE, "utf8")).trim()
			: "");
	assert(
		stripeKeyEnvironment(key) === "production",
		"Production setup requires a live secret key; sandbox keys are rejected",
	);
	const directory =
		process.env.STRIPE_PRODUCTION_ARTIFACT_DIR ?? defaultDirectory;
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	// Exclusive lock prevents two setup processes from creating remote objects.
	const lock = await import("node:fs/promises").then((fs) =>
		fs.open(`${directory}/setup.lock`, "wx", 0o600),
	);
	try {
		let state;
		try {
			state = JSON.parse(await readFile(`${directory}/state.json`, "utf8"));
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			state = {};
		}
		const save = async () => {
			await writeFile(
				`${directory}/state.tmp`,
				JSON.stringify(state, null, 2),
				{ mode: 0o600 },
			);
			await chmod(`${directory}/state.tmp`, 0o600);
			await rename(`${directory}/state.tmp`, `${directory}/state.json`);
		};
		if (command === "install-secrets") {
			assert(
				state.webhookSecret &&
					state.webhookId &&
					state.basePriceId &&
					state.overagePriceId &&
					state.meterId,
				"Run prepare before installing secrets",
			);
		}
		const stripe = new Stripe(key, { maxNetworkRetries: 2, timeout: 20000 });
		const vars = await provision(
			stripe,
			state,
			save,
			process.env.STRIPE_PRODUCT_TAX_CODE ?? state.taxCode,
		);
		if (command === "prepare") {
			let config = await readFile(configPath, "utf8");
			for (const [name, value] of Object.entries(vars))
				config = applyEdits(
					config,
					modify(config, ["vars", name], value, {
						formattingOptions: { insertSpaces: false, tabSize: 2 },
					}),
				);
			await writeFile(configPath, config);
			console.log(
				JSON.stringify(
					{
						prepared: true,
						accountId: state.accountId,
						webhookId: state.webhookId,
						vars,
						checkoutProvider: parse(config).vars.BILLING_DEFAULT_PROVIDER,
						deployed: false,
						productTaxCodeConfigured: Boolean(state.taxCode),
					},
					null,
					2,
				),
			);
		} else {
			const config = parse(await readFile(configPath, "utf8"));
			assert(
				Object.entries(vars).every(
					([name, value]) => config.vars[name] === value,
				),
				"Run prepare before installing secrets",
			);
			const result = spawnSync(
				"bunx",
				["wrangler", "secret", "bulk", "--config", configPath],
				{
					cwd: fileURLToPath(new URL("../", import.meta.url)),
					input: JSON.stringify({
						STRIPE_SECRET_KEY: key,
						STRIPE_WEBHOOK_SECRET: state.webhookSecret,
					}),
					encoding: "utf8",
				},
			);
			// Do not echo subprocess output or SDK errors that could contain credentials.
			assert(
				!result.error && result.status === 0,
				"Secret installation failed; check Cloudflare authentication and retry",
			);
			console.log(
				JSON.stringify({
					secretsInstalled: true,
					worker: config.name,
					checkoutProvider: config.vars.BILLING_DEFAULT_PROVIDER,
					deployed: false,
				}),
			);
		}
	} finally {
		await lock.close();
		const { unlink } = await import("node:fs/promises");
		await unlink(`${directory}/setup.lock`);
	}
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(
			error instanceof assert.AssertionError
				? error.message
				: "Stripe production setup failed; no checkout switch was performed. Inspect the private journal and retry within 23 hours.",
		);
		process.exitCode = 1;
	});
}
