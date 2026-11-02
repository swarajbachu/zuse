import { readFile } from "node:fs/promises";
import { PgClient } from "@effect/sql-pg";
import { makeStripeBillingProvider } from "@zuse/billing-providers/stripe";
import { stripeKeyEnvironment } from "@zuse/billing-providers/stripe-key";
import {
	ApiPaths,
	CLOUD_WORKSPACE_OFFER_ID,
	PREPAID_PRO_CREDIT_AMOUNT,
} from "@zuse/contracts";
import { Effect, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { parse } from "jsonc-parser";
import { Pool } from "pg";
import Stripe from "stripe";
import { makeStripeBillingStorePg } from "../src/stripe-billing-store.ts";
import {
	assertStripeProductionBillingGates,
	webhookEvents,
	webhookUrl,
} from "./stripe-production-setup.mjs";

// Run only after deploying prepaid activation and enabling the credit price/webhooks.
// The recipient signs in normally; the payer need not own the recipient's account.
const [email] = process.argv.slice(2);
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))
	throw new Error(
		"Usage: bun scripts/stripe-prepaid-checkout.mjs RECIPIENT_EMAIL",
	);
const recipient = email.trim().toLowerCase();
const key =
	process.env.STRIPE_SECRET_KEY ??
	(process.env.STRIPE_LIVE_KEY_FILE
		? (await readFile(process.env.STRIPE_LIVE_KEY_FILE, "utf8")).trim()
		: undefined);
if (!key || stripeKeyEnvironment(key) !== "production")
	throw new Error("A live Stripe key is required");
if (!process.env.WORKOS_API_KEY || !process.env.DATABASE_URL)
	throw new Error("WORKOS_API_KEY and production DATABASE_URL are required");
const { vars } = parse(
	await readFile(
		new URL("../wrangler.production.jsonc", import.meta.url),
		"utf8",
	),
);
if (
	vars.BILLING_DEFAULT_PROVIDER !== "stripe" ||
	!vars.STRIPE_PREPAID_CREDIT_PRICE_ID ||
	!vars.STRIPE_PRICE_CLOUD_WORKSPACE_STANDARD_V1 ||
	vars.MACHINE_LIVE_CHECKOUT_ENABLED !== "true" ||
	(vars.STRIPE_CLOUD_BILLING_MODE !== "subscription-only" &&
		!vars.STRIPE_CLOUD_OVERAGE_PRICE_ID)
)
	throw new Error(
		"Deploy and enable Stripe prepaid billing before creating a live link",
	);

assertStripeProductionBillingGates(vars);

const response = await fetch(
	`https://api.workos.com/user_management/users?${new URLSearchParams({ email: recipient, limit: "100" })}`,
	{
		headers: { authorization: `Bearer ${process.env.WORKOS_API_KEY}` },
		signal: AbortSignal.timeout(10_000),
	},
);
if (!response.ok)
	throw new Error(`WorkOS identity lookup failed (${response.status})`);
const users = await response.json();
const matches = users.data?.filter(
	(user) => user.email?.trim().toLowerCase() === recipient,
);
if (
	matches?.length !== 1 ||
	!matches[0].email_verified ||
	!matches[0].id?.startsWith("user_")
)
	throw new Error(
		"Recipient must have exactly one Zuse account with a verified email",
	);
const accountId = matches[0].id;
const stripe = new Stripe(key, { maxNetworkRetries: 1, timeout: 10_000 });

let webhookReady = false;
for await (const endpoint of stripe.webhookEndpoints.list({ limit: 100 })) {
	if (
		endpoint.url === webhookUrl &&
		endpoint.status === "enabled" &&
		webhookEvents.every(
			(event) =>
				endpoint.enabled_events.includes(event) ||
				endpoint.enabled_events.includes("*"),
		)
	)
		webhookReady = true;
}
if (!webhookReady)
	throw new Error("Stripe prepaid webhook delivery is not configured");

const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	max: 2,
	connectionTimeoutMillis: 10_000,
});
const runtime = ManagedRuntime.make(
	PgClient.layerFrom(
		PgClient.fromPool({
			acquire: Effect.succeed(pool),
		}),
	),
);
try {
	const existing = await pool.query(
		"SELECT provider FROM api_entitlements WHERE account_id=$1 AND provider <> 'stripe' AND provider_subscription_id IS NOT NULL AND (status <> 'ended' OR paid_through > $2)",
		[accountId, Date.now()],
	);
	if (existing.rowCount)
		throw new Error(
			"Recipient has another billing provider; do not create a second subscription",
		);
	const sql = await runtime.runPromise(SqlClient.SqlClient);
	const provider = makeStripeBillingProvider(
		{
			secretKey: Redacted.make(key),
			webhookSecret: Redacted.make("unused-for-checkout"),
			offerPrices: {
				[CLOUD_WORKSPACE_OFFER_ID]:
					vars.STRIPE_PRICE_CLOUD_WORKSPACE_STANDARD_V1,
			},
			prepaidCreditPriceId: vars.STRIPE_PREPAID_CREDIT_PRICE_ID,
			cloudOveragePriceId: vars.STRIPE_CLOUD_OVERAGE_PRICE_ID,
			cloudBillingMode: vars.STRIPE_CLOUD_BILLING_MODE,
			automaticTaxEnabled: vars.STRIPE_AUTOMATIC_TAX_ENABLED !== "false",
			portalReturnUrl: "https://api.zuse.sh",
		},
		{ store: makeStripeBillingStorePg(sql) },
	);
	const checkoutUrl = await Effect.runPromise(
		provider.prepaidCheckout({
			accountId,
			amountCents: PREPAID_PRO_CREDIT_AMOUNT,
			activatePro: true,
			successUrl: new URL(
				ApiPaths.billingPrepaidComplete,
				"https://api.zuse.sh",
			).href,
		}),
	);
	console.log(
		JSON.stringify(
			{
				recipient,
				accountId,
				amountCents: PREPAID_PRO_CREDIT_AMOUNT,
				checkoutUrl,
			},
			null,
			2,
		),
	);
} finally {
	await runtime.dispose();
	await pool.end();
}
