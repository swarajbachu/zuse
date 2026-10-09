import { readFile } from "node:fs/promises";
import { BillingProviders } from "@zuse/billing-providers";
import { Effect } from "effect";
import { Client } from "pg";
import Stripe from "stripe";
import { resolveBillingRuntime } from "../src/billing-config.ts";
import {
	migrationScheduleParams,
	validateMigrationManifest,
} from "./stripe-migration.mjs";

const [command, manifestPath] = process.argv.slice(2);
if (
	!["audit", "plan", "schedule"].includes(command) ||
	(command !== "audit" && !manifestPath)
)
	throw new Error(
		"Usage: stripe-billing-migrate.mjs audit | plan MANIFEST.json | schedule MANIFEST.json",
	);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
	if (command === "audit") {
		const { rows } =
			await db.query(`SELECT e.account_id, e.provider_subscription_id, e.offer_id, e.status, e.paid_through, p.period_id, p.period_start, p.period_end, p.overage_cap_micros,
   COALESCE((SELECT SUM(amount_micros) FROM api_cloud_billing_ledger l WHERE l.period_id=p.period_id AND l.kind='overage-charge'),0) AS incurred_overage_micros,
   COALESCE((SELECT SUM(amount_cents) FROM api_cloud_billing_outbox o WHERE o.period_id=p.period_id AND o.acknowledged_at IS NULL),0) AS pending_overage_cents
   FROM api_entitlements e LEFT JOIN api_cloud_billing_periods p ON p.account_id=e.account_id AND p.period_start=e.period_start
   WHERE e.provider='polar' AND (e.status IN ('active','grace','pending') OR e.paid_through > (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint) ORDER BY e.account_id`);
		process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
	} else {
		if (!process.env.STRIPE_SECRET_KEY || !process.env.POLAR_ACCESS_TOKEN)
			throw new Error(
				"Stripe and Polar credentials are required for verification",
			);
		if (
			command === "schedule" &&
			process.env.ZUSE_CONFIRM_STRIPE_MIGRATION !==
				"schedule-verified-transfers"
		)
			throw new Error(
				"Set ZUSE_CONFIRM_STRIPE_MIGRATION=schedule-verified-transfers after provider-assisted payment transfer is complete",
			);
		const manifest = validateMigrationManifest(
			JSON.parse(await readFile(manifestPath, "utf8")),
			Date.now(),
		);
		const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
			maxNetworkRetries: 1,
			timeout: 10_000,
		});
		const runtime = resolveBillingRuntime({
			...process.env,
			BILLING_DEFAULT_PROVIDER: "polar",
		});
		const polar = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* (yield* BillingProviders).get("polar");
			}).pipe(Effect.provide(runtime.layer)),
		);
		const basePrice = process.env.STRIPE_PRICE_CLOUD_WORKSPACE_STANDARD_V1;
		const overagePrice = process.env.STRIPE_CLOUD_OVERAGE_PRICE_ID;
		if (
			!basePrice ||
			!overagePrice ||
			!process.env.STRIPE_CLOUD_OVERAGE_METER_ID
		)
			throw new Error("Configure Stripe cloud prices and overage meter");
		const [base, overage] = await Promise.all([
			stripe.prices.retrieve(basePrice),
			stripe.prices.retrieve(overagePrice),
		]);
		if (
			!base.active ||
			base.currency !== "usd" ||
			base.unit_amount !== 4000 ||
			base.recurring?.interval !== "month" ||
			base.recurring.interval_count !== 1 ||
			base.recurring.usage_type !== "licensed" ||
			!overage.active ||
			overage.currency !== "usd" ||
			overage.unit_amount !== 1 ||
			overage.recurring?.usage_type !== "metered" ||
			overage.recurring.interval !== "month" ||
			overage.recurring.interval_count !== 1 ||
			overage.recurring.meter !== process.env.STRIPE_CLOUD_OVERAGE_METER_ID
		)
			throw new Error(
				"Stripe prices do not match the existing $40 + $0.01/overage-cent policy",
			);
		// Verify the entire cohort before the first remote mutation.
		const plans = [];
		for (const item of manifest) {
			const current = await Effect.runPromise(
				polar.reconcileSubscription(item.polarSubscriptionId),
			);
			const { rows } = await db.query(
				"SELECT paid_through FROM api_entitlements WHERE account_id=$1 AND provider='polar' AND provider_subscription_id=$2 AND offer_id=$3 AND status='active'",
				[item.accountId, item.polarSubscriptionId, item.offerId],
			);
			if (
				rows.length !== 1 ||
				current.accountId !== item.accountId ||
				current.offerId !== item.offerId ||
				current.status !== "active" ||
				current.paidThrough !== item.renewalAtMs ||
				Number(rows[0].paid_through) !== item.renewalAtMs
			)
				throw new Error(
					"Manifest does not match the active Polar subscription and local entitlement",
				);
			const customer = await stripe.customers.retrieve(item.stripeCustomerId);
			if (
				customer.deleted ||
				customer.metadata.account_id !== item.accountId ||
				!customer.invoice_settings.default_payment_method ||
				!customer.address?.country ||
				!customer.address?.postal_code
			)
				throw new Error(
					"Imported Stripe customer needs verified ownership, default payment method and billing location",
				);
			const paymentMethod = await stripe.paymentMethods.retrieve(
				typeof customer.invoice_settings.default_payment_method === "string"
					? customer.invoice_settings.default_payment_method
					: customer.invoice_settings.default_payment_method.id,
			);
			if (
				(typeof paymentMethod.customer === "string"
					? paymentMethod.customer
					: paymentMethod.customer?.id) !== item.stripeCustomerId
			)
				throw new Error(
					"Payment method is not attached to the imported customer",
				);
			const active = await stripe.subscriptions.list({
				customer: item.stripeCustomerId,
				status: "all",
				limit: 100,
			});
			if (
				active.has_more ||
				active.data.some(
					(sub) => !["canceled", "incomplete_expired"].includes(sub.status),
				)
			)
				throw new Error("Imported customer already has a Stripe subscription");
			const binding = await db.query(
				"SELECT customer_id FROM api_stripe_customers WHERE account_id=$1",
				[item.accountId],
			);
			if (
				binding.rows[0]?.customer_id &&
				binding.rows[0].customer_id !== item.stripeCustomerId
			)
				throw new Error(
					"Imported customer conflicts with existing local binding",
				);
			const intent = await db.query(
				"SELECT schedule_id, first_attempt_at FROM api_stripe_subscription_migrations WHERE polar_subscription_id=$1 AND account_id=$2 AND customer_id=$3",
				[item.polarSubscriptionId, item.accountId, item.stripeCustomerId],
			);
			const schedules = await stripe.subscriptionSchedules.list({
				customer: item.stripeCustomerId,
				limit: 100,
			});
			if (
				schedules.has_more ||
				schedules.data.some(
					(schedule) =>
						["not_started", "active"].includes(schedule.status) &&
						(schedule.metadata.polar_subscription_id !==
							item.polarSubscriptionId ||
							!intent.rows[0] ||
							(intent.rows[0].schedule_id &&
								intent.rows[0].schedule_id !== schedule.id)),
				)
			)
				throw new Error(
					"Imported customer already has another pending Stripe schedule",
				);
			const params = migrationScheduleParams(item, basePrice, overagePrice);
			plans.push({ item, params });
		}
		if (command === "plan")
			process.stdout.write(`${JSON.stringify(plans, null, 2)}\n`);
		else
			for (const { item, params } of plans) {
				// Commit intent before calling Stripe; retain it across interruption.
				await db.query(
					"INSERT INTO api_stripe_subscription_migrations (polar_subscription_id,account_id,customer_id,payload,first_attempt_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
					[
						item.polarSubscriptionId,
						item.accountId,
						item.stripeCustomerId,
						JSON.stringify(params),
						Date.now(),
					],
				);
				const { rows } = await db.query(
					"SELECT * FROM api_stripe_subscription_migrations WHERE polar_subscription_id=$1",
					[item.polarSubscriptionId],
				);
				const attempt = rows[0];
				if (
					attempt.payload !== JSON.stringify(params) ||
					attempt.account_id !== item.accountId ||
					attempt.customer_id !== item.stripeCustomerId
				)
					throw new Error("Migration intent conflict");
				let scheduleId = attempt.schedule_id;
				if (!scheduleId) {
					if (Date.now() - Number(attempt.first_attempt_at) >= 23 * 60 * 60_000)
						throw new Error(
							"Unresolved migration exceeds Stripe retry window; reconcile schedule manually",
						);
					const schedule = await stripe.subscriptionSchedules.create(params, {
						idempotencyKey: `zuse-migration:${item.polarSubscriptionId}`,
					});
					scheduleId = schedule.id;
					await db.query(
						"UPDATE api_stripe_subscription_migrations SET schedule_id=$2 WHERE polar_subscription_id=$1",
						[item.polarSubscriptionId, scheduleId],
					);
				}
				const schedule =
					await stripe.subscriptionSchedules.retrieve(scheduleId);
				if (
					schedule.status !== "not_started" ||
					schedule.phases[0]?.start_date !== item.renewalAtMs / 1000
				)
					throw new Error("Scheduled transfer is no longer safely pending");
				await db
					.query(
						"INSERT INTO api_stripe_customers (account_id,customer_id,created_at) VALUES ($1,$2,$3) ON CONFLICT (account_id) DO UPDATE SET customer_id=EXCLUDED.customer_id WHERE api_stripe_customers.customer_id IS NULL OR api_stripe_customers.customer_id=EXCLUDED.customer_id RETURNING account_id",
						[item.accountId, item.stripeCustomerId, Date.now()],
					)
					.then(({ rows }) => {
						if (rows.length !== 1) throw new Error("Customer binding conflict");
					});
				// Canceling Polar renewals is a separate reviewed operator action. Never
				// revoke an existing paid entitlement or erase its outstanding usage.
				process.stdout.write(
					`${JSON.stringify({ accountId: item.accountId, polarSubscriptionId: item.polarSubscriptionId, stripeScheduleId: scheduleId, renewalAtMs: item.renewalAtMs, nextAction: "verify-schedule-then-disable-polar-renewal" })}\n`,
				);
			}
	}
} finally {
	await db.end();
}
