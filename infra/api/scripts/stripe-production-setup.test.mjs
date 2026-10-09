import assert from "node:assert/strict";
import { test } from "node:test";
import Stripe from "stripe";
import {
	assertStripeProductionBillingGates,
	productionVars,
	provision,
	webhookEvents,
	webhookUrl,
} from "./stripe-production-setup.mjs";

function fixture() {
	const resources = {
		meters: [],
		prices: [],
		endpoints: [],
		products: [],
		portals: [],
	};
	const keys = [];
	let accountId = "acct_live";
	const listing = (items) => ({ autoPagingToArray: async () => items });
	function create(items, prefix, enrich = (x) => x) {
		return async (params, options) => {
			keys.push(options.idempotencyKey);
			const object = {
				id: `${prefix}_${items.length}`,
				livemode: true,
				...enrich(params),
			};
			items.push(object);
			return object;
		};
	}
	const stripe = {
		accounts: {
			retrieve: async () => ({ id: accountId, charges_enabled: true }),
		},
		billing: {
			meters: {
				list: () => listing(resources.meters),
				create: create(resources.meters, "mtr", (x) => ({
					...x,
					status: "active",
					event_time_window: null,
				})),
			},
		},
		products: {
			create: create(resources.products, "prod", (x) => ({
				...x,
				active: true,
			})),
			retrieve: async (id) => resources.products.find((x) => x.id === id),
		},
		prices: {
			create: create(resources.prices, "price", (x) => ({
				...x,
				active: true,
				billing_scheme: "per_unit",
				recurring: x.recurring ? { ...x.recurring, interval_count: 1 } : null,
			})),
			list: async (params) => ({
				data: resources.prices.filter((x) =>
					params.lookup_keys.includes(x.lookup_key),
				),
			}),
			retrieve: async (id) => resources.prices.find((x) => x.id === id),
		},
		billingPortal: {
			configurations: {
				create: create(resources.portals, "bpc", (x) => ({
					...x,
					active: true,
				})),
				retrieve: async (id) => resources.portals.find((x) => x.id === id),
			},
		},
		webhookEndpoints: {
			list: () => listing(resources.endpoints),
			create: create(resources.endpoints, "we", (x) => ({
				...x,
				status: "enabled",
				secret: "whsec_private",
			})),
			retrieve: async (id) => resources.endpoints.find((x) => x.id === id),
			update: async (id, params) =>
				Object.assign(
					resources.endpoints.find((x) => x.id === id),
					params,
				),
		},
	};
	return {
		stripe,
		resources,
		keys,
		changeAccount: () => {
			accountId = "acct_other";
		},
	};
}

test("creates the live catalogue and pinned webhook without subscriptions; completed rerun creates nothing", async () => {
	const { stripe, resources, keys } = fixture();
	const state = {};
	const snapshots = [];
	const save = async () => snapshots.push(structuredClone(state));
	const vars = await provision(stripe, state, save, "txcd_verified", 1000);
	assert.equal(vars.STRIPE_ENVIRONMENT, "production");
	assert.equal(resources.meters.length, 3);
	assert.deepEqual(
		resources.prices.map((p) => p.unit_amount),
		[4000, 1, 100],
	);
	assert.equal(resources.prices[1].recurring.meter, state.meterId);
	assert.equal(resources.endpoints[0].url, webhookUrl);
	assert.equal(resources.endpoints[0].api_version, Stripe.API_VERSION);
	assert.deepEqual(resources.endpoints[0].enabled_events, webhookEvents);
	assert(snapshots.some((s) => s.attempts.product && !s.productId));
	assert.equal(new Set(keys).size, 10);
	await provision(stripe, state, save, "txcd_verified", 48 * 3600000);
	assert.equal(keys.length, 10);
	assert(!("BILLING_DEFAULT_PROVIDER" in productionVars(state)));
});

test("rejects incompatible existing meters and prices rather than silently changing billing", async () => {
	const { stripe, resources } = fixture();
	const state = {};
	await provision(stripe, state, async () => {}, "txcd_verified", 1000);
	resources.meters[0].default_aggregation.formula = "count";
	await assert.rejects(
		provision(stripe, state, async () => {}, "txcd_verified", 2000),
		/Incompatible meter/,
	);
	resources.meters[0].default_aggregation.formula = "sum";
	resources.prices[1].unit_amount = 100;
	await assert.rejects(
		provision(stripe, state, async () => {}, "txcd_verified", 2000),
		/Incompatible live price/,
	);
});

test("rejects another live account or a changed tax classification", async () => {
	const { stripe, changeAccount } = fixture();
	const state = {};
	await provision(stripe, state, async () => {}, "txcd_verified", 1000);
	await assert.rejects(
		provision(stripe, state, async () => {}, "txcd_other", 2000),
		/tax code cannot change/,
	);
	changeAccount();
	await assert.rejects(
		provision(stripe, state, async () => {}, "txcd_verified", 2000),
		/another Stripe account/,
	);
});

test("an ambiguous mutation retains its original key and expires instead of creating new resources", async () => {
	const { stripe, keys } = fixture();
	const create = stripe.products.create;
	stripe.products.create = async (_params, options) => {
		keys.push(options.idempotencyKey);
		throw new Error("response lost");
	};
	const state = {};
	await assert.rejects(
		provision(stripe, state, async () => {}, "txcd_verified", 1000),
		/response lost/,
	);
	const key = keys.at(-1);
	stripe.products.create = create;
	await assert.rejects(
		provision(stripe, state, async () => {}, "txcd_verified", 24 * 3600000),
		/older than 23 hours/,
	);
	await provision(stripe, state, async () => {}, "txcd_verified", 2000);
	assert.equal(keys[4], key);
});

test("an existing webhook without its private journal requires reconciliation", async () => {
	const { stripe, resources } = fixture();
	resources.endpoints.push({ url: webhookUrl });
	await assert.rejects(
		provision(stripe, {}, async () => {}, "txcd_verified", 1000),
		/endpoint already exists/,
	);
	assert.equal(resources.endpoints.length, 1);
});

test("Stripe checkout cannot deploy with exports or cap enforcement disabled", () => {
	assertStripeProductionBillingGates({ BILLING_DEFAULT_PROVIDER: "polar" });
	for (const gate of [
		"CLOUD_BILLING_EXPORT_ENABLED",
		"CLOUD_BILLING_ENFORCEMENT_ENABLED",
	]) {
		const vars = {
			BILLING_DEFAULT_PROVIDER: "stripe",
			CLOUD_BILLING_EXPORT_ENABLED: "true",
			CLOUD_BILLING_ENFORCEMENT_ENABLED: "true",
			[gate]: "false",
		};
		assert.throws(
			() => assertStripeProductionBillingGates(vars),
			/requires overage export and spend-cap enforcement/,
		);
	}
	assertStripeProductionBillingGates({
		BILLING_DEFAULT_PROVIDER: "stripe",
		CLOUD_BILLING_EXPORT_ENABLED: "true",
		CLOUD_BILLING_ENFORCEMENT_ENABLED: "true",
	});
});

test("catalogue can be prepared with tax configuration explicitly pending", async () => {
	const { stripe, resources } = fixture();
	const state = {};
	const vars = await provision(stripe, state, async () => {}, undefined, 1000);
	assert.equal(resources.products[0].tax_code, undefined);
	assert.equal(state.taxCode, undefined);
	assert.equal(
		vars.STRIPE_PORTAL_CONFIGURATION_ID,
		state.portalConfigurationId,
	);
	assert.equal(
		resources.portals[0].features.subscription_update.enabled,
		false,
	);
	assert.equal(
		resources.portals[0].features.subscription_cancel.mode,
		"at_period_end",
	);
});

test("upgrades an existing webhook in place and preserves its secret and unrelated events", async () => {
	const { stripe, resources } = fixture();
	const state = {};
	await provision(stripe, state, async () => {}, "", 1000);
	const secret = state.webhookSecret;
	const webhookId = state.webhookId;
	resources.endpoints[0].enabled_events = ["invoice.paid", "customer.created"];
	await provision(stripe, state, async () => {}, "", 2000);
	assert.equal(resources.endpoints.length, 1);
	assert.equal(state.webhookId, webhookId);
	assert.equal(state.webhookSecret, secret);
	assert(resources.endpoints[0].enabled_events.includes("customer.created"));
	assert(
		webhookEvents.every((event) =>
			resources.endpoints[0].enabled_events.includes(event),
		),
	);
	assert(state.attempts.webhookPrepaidV1);
});

test("rejects an incompatible prepaid SKU without publishing its price", async () => {
	const { stripe, resources } = fixture();
	const state = {};
	await provision(stripe, state, async () => {}, "", 1000);
	assert.equal(
		productionVars(state).STRIPE_PREPAID_CREDIT_PRICE_ID,
		state.prepaidPriceId,
	);
	resources.prices[2].unit_amount = 200;
	await assert.rejects(
		provision(stripe, state, async () => {}, "", 2000),
		/Incompatible prepaid price/,
	);
});
