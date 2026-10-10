import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { PgClient } from "@effect/sql-pg";
import {
	BillingProviderManual,
	BillingProviders,
} from "@zuse/billing-providers";
import { makeStripeBillingProvider } from "@zuse/billing-providers/stripe";
import { SandboxProviders } from "@zuse/sandbox-providers";
import { makeBoxdSandboxProvider } from "@zuse/sandbox-providers/boxd";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Client, Pool } from "pg";
import Stripe from "stripe";
import { flushCloudBillingOutbox } from "../src/cloud-billing-outbox.ts";
import { ensureCloudBillingPeriod } from "../src/cloud-billing-period.ts";
import {
	CloudBillingStore,
	CloudBillingStorePg,
} from "../src/cloud-billing-store.ts";
import { BoxdBillingUsageSourceModule } from "../src/cloud-billing-usage-sources/boxd.ts";
import { CloudWorkspaceStorePg } from "../src/cloud-workspace-store.ts";
import { ApiConfiguration } from "../src/config.ts";
import { routeMachineRequest } from "../src/machine-routes.ts";
import { MachineStore, MachineStorePg } from "../src/machine-store.ts";
import { makeStripeBillingStorePg } from "../src/stripe-billing-store.ts";
import { migrationScheduleParams } from "./stripe-migration.mjs";
import { acquireRunnerLock } from "./stripe-sandbox-lock.mjs";

// Opt-in, real sandbox API testing. All state is outside version control.
// Run with Bun from the repository root. Never accepts live keys or databases.
const directory =
	process.env.STRIPE_TEST_ARTIFACT_DIR ?? ".context/stripe-sandbox";
const statePath = `${directory}/state.json`;
const key =
	process.env.STRIPE_SECRET_KEY ??
	(
		await readFile(
			process.env.STRIPE_TEST_KEY_FILE ?? ".context/stripe-sandbox-key",
			"utf8",
		)
	).trim();
assert(key.startsWith("sk_test_"), "A Stripe test key is required");
const stripe = new Stripe(key, { maxNetworkRetries: 1, timeout: 15000 });
const connectionString = process.env.ZUSE_TEST_DATABASE_URL;
assert(
	connectionString,
	"ZUSE_TEST_DATABASE_URL must point to an isolated test database",
);
const databaseHost = new URL(connectionString).hostname;
assert(
	["127.0.0.1", "localhost", "::1", "[::1]"].includes(databaseHost),
	"Only a local test database is allowed",
);
const command = process.argv[2];
if (command !== "serve") acquireRunnerLock(directory);
let state;
try {
	state = JSON.parse(await readFile(statePath, "utf8"));
} catch (error) {
	if (error.code !== "ENOENT") throw error;
}
const save = () =>
	writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const record = async (name, details) => {
	state.results ??= [];
	state.results.push({
		name,
		status: "passed",
		details,
		at: new Date().toISOString(),
	});
	await save();
	console.log(JSON.stringify({ check: name, status: "passed", details }));
};
const waitFor = async (name, operation, timeoutMs = 180000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await operation();
		if (result) return result;
		await delay(2000);
	}
	throw new Error(`Timed out waiting for ${name}`);
};

if (command === "prepare") {
	assert(
		!state,
		"Existing test run found; reuse its fixtures instead of recreating them",
	);
	state = {
		runId: `zuse_${Date.now()}`,
		schema: `stripe_sandbox_${crypto.randomUUID().replaceAll("-", "")}`,
		results: [],
		customers: [],
		clocks: [],
		subscriptions: [],
		schedules: [],
		checkoutSessions: [],
	};
	await save();
	const account = await stripe.accounts.retrieve();
	state.accountId = account.id;
	state.taxSettingsBefore = await stripe.tax.settings.retrieve();
	await save();
	if (state.taxSettingsBefore.status !== "active") {
		await stripe.tax.settings.update({
			head_office: {
				address: {
					country: "US",
					state: "NY",
					city: "New York",
					postal_code: "10001",
					line1: "123 Test Street",
				},
			},
			defaults: { tax_code: "txcd_10103000", tax_behavior: "exclusive" },
		});
		state.testTaxSettingsConfigured = true;
		await save();
	}
	const registrations = await stripe.tax.registrations.list({
		status: "active",
		limit: 100,
	});
	if (
		!registrations.data.some(
			(r) => r.country === "US" && r.country_options.us?.state === "NY",
		)
	) {
		const registration = await stripe.tax.registrations.create({
			country: "US",
			country_options: { us: { state: "NY", type: "state_sales_tax" } },
			active_from: "now",
		});
		state.testTaxRegistrationId = registration.id;
		await save();
	}
	const meters = await stripe.billing.meters.list({ limit: 100 });
	assert(
		!meters.has_more,
		"Review existing meter pagination before proceeding",
	);
	const found = meters.data.find(
		(m) => m.event_name === "zuse_cloud_overage_cent" && m.status === "active",
	);
	const meter =
		found ??
		(await stripe.billing.meters.create({
			display_name: `Zuse sandbox overage (${state.runId})`,
			event_name: "zuse_cloud_overage_cent",
			default_aggregation: { formula: "sum" },
			customer_mapping: {
				type: "by_id",
				event_payload_key: "stripe_customer_id",
			},
			value_settings: { event_payload_key: "value" },
		}));
	assert.equal(meter.default_aggregation.formula, "sum");
	assert.equal(meter.customer_mapping.event_payload_key, "stripe_customer_id");
	assert.equal(meter.value_settings.event_payload_key, "value");
	state.meterId = meter.id;
	state.createdMeter = !found;
	await save();
	const product = await stripe.products.create({
		name: `Zuse sandbox Cloud Workspace (${state.runId})`,
		tax_code: "txcd_10103000",
		metadata: { zuse_test_run: state.runId },
	});
	state.productId = product.id;
	await save();
	const base = await stripe.prices.create({
		product: product.id,
		currency: "usd",
		unit_amount: 4000,
		recurring: { interval: "month" },
		tax_behavior: "exclusive",
		metadata: { zuse_test_run: state.runId },
	});
	state.basePriceId = base.id;
	await save();
	const overage = await stripe.prices.create({
		product: product.id,
		currency: "usd",
		unit_amount: 1,
		recurring: { interval: "month", usage_type: "metered", meter: meter.id },
		tax_behavior: "exclusive",
		metadata: { zuse_test_run: state.runId },
	});
	state.overagePriceId = overage.id;
	await save();
	const db = new Client({ connectionString });
	await db.connect();
	try {
		await db.query(`CREATE SCHEMA ${state.schema}`);
		await db.query(`SET search_path=${state.schema}`);
		const migrations = new URL("../drizzle/migrations/", import.meta.url);
		for (const name of (await readdir(migrations))
			.filter((n) => n.endsWith(".sql"))
			.sort())
			await db.query(
				(await readFile(new URL(name, migrations), "utf8")).replaceAll(
					'"public".',
					`"${state.schema}".`,
				),
			);
	} finally {
		await db.end();
	}
	await record("sandbox fixtures and isolated PostgreSQL schema", {
		accountId: account.id,
		schema: state.schema,
		meterId: meter.id,
	});
	process.exit(0);
}
assert(state, "Run prepare first");
assert(/^stripe_sandbox_[a-f0-9]+$/.test(state.schema), "Invalid test schema");
const dbLayer = PgClient.layerFrom(
	PgClient.fromPool({
		acquire: Effect.acquireRelease(
			Effect.sync(
				() =>
					new Pool({
						connectionString,
						options: `-c search_path=${state.schema}`,
					}),
			),
			(pool) => Effect.promise(() => pool.end()),
		),
	}),
);
const runtime = ManagedRuntime.make(
	Layer.mergeAll(
		dbLayer,
		CloudBillingStorePg.pipe(Layer.provide(dbLayer)),
		MachineStorePg.pipe(Layer.provide(dbLayer)),
		CloudWorkspaceStorePg.pipe(Layer.provide(dbLayer)),
	),
);
const db = new Client({
	connectionString,
	options: `-c search_path=${state.schema}`,
});
await db.connect();
const sql = await runtime.runPromise(SqlClient.SqlClient);
const persistence = makeStripeBillingStorePg(sql);
const billing = await runtime.runPromise(CloudBillingStore);
let logicalNow = Date.now();
const adapter = makeStripeBillingProvider(
	{
		secretKey: Redacted.make(key),
		webhookSecret: Redacted.make(state.webhookSecret ?? "unregistered"),
		offerPrices: { "cloud-workspace-standard-v1": state.basePriceId },
		cloudOveragePriceId: state.overagePriceId,
		portalReturnUrl: "https://example.com/zuse-sandbox",
	},
	{
		store: persistence,
		now: () => logicalNow,
		verifyWebhook: async (body, signature) => {
			const current = JSON.parse(await readFile(statePath, "utf8"));
			assert(current.webhookSecret, "Webhook setup is pending");
			return stripe.webhooks.constructEventAsync(
				body,
				signature,
				current.webhookSecret,
				undefined,
				Stripe.createSubtleCryptoProvider(),
			);
		},
	},
);
const providersLayer = BillingProviders.layer({
	adapters: [BillingProviderManual, adapter],
	defaultProviderId: "stripe",
}).pipe(Layer.orDie);
const run = (operation) =>
	runtime.runPromise(operation.pipe(Effect.provide(providersLayer)));

if (command === "serve") {
	const server = Bun.serve({
		hostname: "0.0.0.0",
		port: Number(process.env.STRIPE_TEST_PORT ?? 4317),
		fetch: async (request) => {
			const path = new URL(request.url).pathname;
			if (path === "/health") return Response.json({ sandbox: true });
			if (path === "/complete")
				return new Response(
					"Zuse sandbox payment completed. No real money was charged.",
				);
			if (path !== "/v1/billing/webhook/stripe" || request.method !== "POST")
				return new Response("Not found", { status: 404 });
			const body = await request.text();
			try {
				const response = await run(
					routeMachineRequest(
						new Request(request.url, {
							method: "POST",
							headers: request.headers,
							body,
						}),
					),
				);
				await writeFile(
					`${directory}/webhook-events.jsonl`,
					`${JSON.stringify({ at: new Date().toISOString(), signature: request.headers.get("stripe-signature"), body, status: response?.status })}\n`,
					{ flag: "a", mode: 0o600 },
				);
				return response ?? new Response("Not found", { status: 404 });
			} catch (error) {
				const cause = String(error);
				console.log(JSON.stringify({ webhookError: cause.slice(0, 300) }));
				return new Response("Webhook processing failed", {
					status: error?.status ?? 503,
				});
			}
		},
	});
	console.log(JSON.stringify({ listening: server.port, sandbox: true }));
	await new Promise(() => {});
}

try {
	if (command === "connect") {
		const url = process.env.STRIPE_TEST_PUBLIC_URL;
		assert(url?.startsWith("https://"), "STRIPE_TEST_PUBLIC_URL is required");
		assert(!state.webhookId, "Webhook already registered");
		const endpoint = await stripe.webhookEndpoints.create({
			url: `${url}/v1/billing/webhook/stripe`,
			api_version: Stripe.API_VERSION,
			enabled_events: [
				"customer.subscription.created",
				"customer.subscription.updated",
				"customer.subscription.deleted",
				"customer.subscription.paused",
				"customer.subscription.resumed",
				"invoice.paid",
				"invoice.payment_failed",
			],
			description: `Zuse sandbox verification ${state.runId}`,
		});
		assert.equal(endpoint.livemode, false);
		state.webhookId = endpoint.id;
		state.webhookSecret = endpoint.secret;
		state.publicUrl = url;
		await save();
		await record("real Stripe sandbox webhook registered", {
			webhookId: endpoint.id,
		});
	} else if (command === "checkout") {
		assert(state.publicUrl, "Connect a webhook first");
		const accountId = `${state.runId}_checkout_${state.checkoutSessions.length}`;
		const url = await Effect.runPromise(
			adapter.checkout({
				accountId,
				offerId: "cloud-workspace-standard-v1",
				successUrl: `${state.publicUrl}/complete?checkout_id={CHECKOUT_ID}`,
			}),
		);
		const customerId = await persistence.getCustomer(accountId);
		state.customers.push(customerId);
		state.checkoutAccountId = accountId;
		state.checkoutUrl = url;
		const sessions = await stripe.checkout.sessions.list({
			customer: customerId,
			limit: 1,
		});
		state.checkoutSessionId = sessions.data[0].id;
		state.checkoutSessions.push(state.checkoutSessionId);
		await save();
		await record("Zuse adapter created hosted checkout", {
			sessionId: state.checkoutSessionId,
			automaticTax: sessions.data[0].automatic_tax.enabled,
		});
		console.log(JSON.stringify({ checkoutUrl: url }));
	} else if (command === "provider-evidence") {
		// Replay captured, authenticated provider evidence through the actual
		// adapter, ingestion, PostgreSQL ledger and Stripe test-mode exporter.
		// Seed the included allowance so even a small real cost exercises billing.
		const path = process.env.STRIPE_TEST_PROVIDER_EVIDENCE_FILE;
		assert(path, "STRIPE_TEST_PROVIDER_EVIDENCE_FILE is required");
		const evidence = JSON.parse(await readFile(path, "utf8"));
		const captured = evidence.report.productionMachine;
		assert(captured.complete && captured.currency === "usd");
		assert(Number.isSafeInteger(captured.costMicro) && captured.costMicro > 0);
		const start = Date.parse(captured.period.start);
		const end = Date.parse(captured.period.end);
		assert(
			Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > start,
		);
		assert(end < Date.now() - 30 * 60_000, "Use a completed provider window");
		const accountId = `${state.runId}_provider_${crypto.randomUUID()}`;
		const clock = await stripe.testHelpers.testClocks.create({
			frozen_time: Math.floor(start / 1000),
			name: accountId,
		});
		state.clocks.push(clock.id);
		await save();
		const customer = await stripe.customers.create({
			test_clock: clock.id,
			payment_method: "pm_card_visa",
			invoice_settings: { default_payment_method: "pm_card_visa" },
			metadata: { account_id: accountId, zuse_test_run: state.runId },
		});
		state.customers.push(customer.id);
		await save();
		await persistence.reserveCustomer(accountId);
		await persistence.linkCustomer(accountId, customer.id);
		const sub = await stripe.subscriptions.create({
			customer: customer.id,
			items: [
				{ price: state.basePriceId, quantity: 1 },
				{ price: state.overagePriceId },
			],
			automatic_tax: { enabled: false },
			metadata: {
				account_id: accountId,
				offer_id: "cloud-workspace-standard-v1",
				zuse_test_run: state.runId,
			},
		});
		state.subscriptions.push(sub.id);
		await save();
		try {
			assert.equal(sub.status, "active");
			const remote = await Effect.runPromise(
				adapter.reconcileSubscription(sub.id),
			);
			const machineStore = await runtime.runPromise(MachineStore);
			await run(
				machineStore.upsertEntitlement({
					entitlementId: `stripe:${sub.id}`,
					accountId,
					provider: "stripe",
					kind: "cloud-workspace",
					offerId: remote.offerId,
					providerSubscriptionId: sub.id,
					status: remote.status,
					periodStartMs: remote.periodStart,
					paidThroughMs: remote.paidThrough,
					createdAtMs: start,
					updatedAtMs: Date.now(),
				}),
			);
			const period = await run(
				ensureCloudBillingPeriod({
					accountId,
					provider: "stripe",
					providerSubscriptionId: sub.id,
					subscriptionStatus: remote.status,
					periodStartMs: remote.periodStart,
					periodEndMs: remote.paidThrough,
					nowMs: end,
				}),
			);
			await run(
				billing.recordProviderEvent({
					provider: "sandbox-fixture",
					eventId: `${accountId}_allowance`,
					type: "allowance-fixture",
					payload: {},
					receivedAtMs: end,
					expiresAtMs: end + 86400000,
				}),
			);
			await run(
				billing.recordProviderExecutionBatch({
					provider: "sandbox-fixture",
					eventId: `${accountId}_allowance`,
					providerExecutionId: `${accountId}_allowance`,
					finalizedAtMs: end,
					usage: [
						{
							entryId: `${accountId}_allowance`,
							accountId,
							periodId: period.periodId,
							resourceKind: "workspace",
							resourceId: accountId,
							provider: "sandbox-fixture",
							providerExecutionId: `${accountId}_allowance`,
							startedAt: start,
							endedAt: start + 1000,
							vcpuCount: 2,
							memoryMib: 8192,
							providerCostMicros: 35000000,
							status: "confirmed",
							nowMs: end,
						},
					],
				}),
			);
			await db.query(
				`INSERT INTO api_cloud_projects
				 (project_id,account_id,repository_identity,repository_url,display_name,
				 default_branch,visibility,git_connection_kind,configuration_digest,state,
				 idempotency_key,created_at,updated_at)
				 VALUES ($1,$1,$1,'https://example.invalid/verification','Verification',
				 'main','private','github','verification','ready',$1,$2,$2)`,
				[accountId, start],
			);
			await db.query(
				`INSERT INTO api_cloud_project_builds
				 (build_id,project_id,account_id,provider,template_version,configuration_digest,
				 state,idempotency_key,next_action_at,created_at,updated_at)
				 VALUES ($1,$1,$1,'boxd','verification','verification','ready',$1,$2,$2,$2)`,
				[accountId, start],
			);
			// This runner is restricted to its isolated local test schema. Release
			// a previous canceled fixture's machine mapping before repeating it.
			await db.query(
				"DELETE FROM api_cloud_workspaces WHERE provider='boxd' AND provider_sandbox_id=$1 AND account_id LIKE $2",
				[captured.machineId, `${state.runId}_provider_%`],
			);
			await db.query(
				`INSERT INTO api_cloud_workspaces
			 (workspace_id,account_id,project_id,build_id,provider,provider_sandbox_id,chat_id,
			 initial_session_id,branch,base_ref,state,desired_state,status_code,idempotency_key,
			 next_action_at,created_at,updated_at,last_activity_at)
			 VALUES ($1,$1,$1,$1,'boxd',$2,$1,$1,'main','main','paused','paused','ready',$1,$3,$3,$3,$3)`,
				[accountId, captured.machineId, start],
			);
			const boxd = makeBoxdSandboxProvider(
				{
					apiKey: Redacted.make("captured-evidence-only"),
					org: "zuse",
					templateSnapshot: "unused",
					templateVersion: "unused",
					billingUsageEnabled: true,
				},
				{
					machines: {
						usage: async (id, window) => {
							assert.equal(id, captured.machineId);
							assert.equal(window.since * 1000, start);
							assert.equal(window.until * 1000, end);
							return {
								...captured,
								period: { start: new Date(start), end: new Date(end) },
							};
						},
					},
				},
			);
			const sandboxLayer = SandboxProviders.layer({
				registrations: [{ adapter: boxd }],
				defaultProviderId: "boxd",
			}).pipe(Layer.orDie);
			const ingest = () =>
				run(
					BoxdBillingUsageSourceModule.ingestPolled(
						[
							{
								id: `${accountId}_window`,
								machineId: captured.machineId,
								startedAtMs: start,
								endedAtMs: end,
							},
						],
						end + 3600000,
					).pipe(
						Effect.provide(sandboxLayer),
						Effect.provideService(ApiConfiguration, {
							cloudBillingCutoverAtMs: start,
							cloudBillingProviderCutoverAtMs: new Map([["boxd", start]]),
						}),
					),
				);
			assert.equal(await ingest(), 1);
			assert.equal(
				await ingest(),
				0,
				"Duplicate evidence must not charge twice",
			);
			const summary = await run(billing.summary(period));
			const expectedMicros = Number((BigInt(captured.costMicro) * 105n) / 100n);
			const expectedCents = Number((BigInt(expectedMicros) + 5000n) / 10000n);
			assert.equal(summary.providerCostMicros, 35000000 + captured.costMicro);
			assert.equal(summary.includedUsedMicros, 35000000);
			assert.equal(summary.overageChargeMicros, expectedMicros);
			const rows = await db.query(
				"SELECT provider_cost_micros FROM api_cloud_billing_usage WHERE provider='boxd' AND account_id=$1",
				[accountId],
			);
			assert.equal(rows.rows.length, 1);
			assert.equal(
				Number(rows.rows[0].provider_cost_micros),
				captured.costMicro,
			);
			// Meter timestamps must not be in this customer's simulated future.
			await stripe.testHelpers.testClocks.advance(clock.id, {
				frozen_time: Math.floor(end / 1000),
			});
			await waitFor(
				"provider evidence clock reaches usage window",
				async () =>
					(await stripe.testHelpers.testClocks.retrieve(clock.id)).status ===
					"ready",
			);
			await run(flushCloudBillingOutbox(Date.now(), 25));
			assert(
				!(await run(billing.pendingOutbox(Date.now(), 25))).some(
					(item) => item.accountId === accountId,
				),
			);
			await waitFor(
				"captured-provider-cost meter aggregation",
				async () =>
					(await Effect.runPromise(
						adapter.reconcileMeter({
							accountId,
							meterId: state.meterId,
							periodStartMs: period.periodStartMs,
							periodEndMs: period.periodEndMs,
						}),
					)) === expectedCents,
			);
			await stripe.testHelpers.testClocks.advance(clock.id, {
				frozen_time: period.periodEndMs / 1000,
			});
			await waitFor(
				"provider evidence clock",
				async () =>
					(await stripe.testHelpers.testClocks.retrieve(clock.id)).status ===
					"ready",
			);
			let invoice = await waitFor(
				"provider evidence renewal invoice",
				async () =>
					(
						await stripe.invoices.list({
							customer: customer.id,
							subscription: sub.id,
							limit: 10,
						})
					).data.find((i) => i.billing_reason === "subscription_cycle"),
			);
			if (invoice.status === "draft")
				invoice = await stripe.invoices.finalizeInvoice(invoice.id);
			if (invoice.status === "open")
				invoice = await stripe.invoices.pay(invoice.id);
			assert.equal(invoice.status, "paid");
			assert.equal(invoice.total, 4000 + expectedCents);
			await record(
				"captured Boxd evidence agrees with ledger, Stripe meter and paid test invoice",
				{
					provider: "boxd",
					providerMachineId: captured.machineId,
					windowStart: captured.period.start,
					windowEnd: captured.period.end,
					providerCostMicros: captured.costMicro,
					seededAllowanceMicros: 35000000,
					ledgerOverageMicros: summary.overageChargeMicros,
					stripeMeterCents: expectedCents,
					invoiceCents: invoice.total,
					invoiceId: invoice.id,
					duplicateSettlement: "no additional charge",
					mode: "test",
				},
			);
		} finally {
			await stripe.subscriptions.cancel(sub.id, {
				invoice_now: false,
				prorate: false,
			});
		}
	} else if (command === "run") {
		// Past anchors keep all usage timestamps inside Stripe's wall-clock window.
		const anchor =
			state.fixtures?.[0]?.periodStartMs / 1000 ||
			Math.floor((Date.now() - 20 * 86400000) / 60000) * 60;
		state.fixtures ??= [];
		await save();
		for (const [index, cost, expectedCents] of [
			[0, 34000000, 0],
			[1, 35000000, 0],
			[2, 36000000, 105],
			[3, 100000000, 2500],
		]) {
			const existing = state.fixtures.find(
				(f) => f.accountId === `${state.runId}_cost_${index}`,
			);
			if (existing?.invoiceId) continue;
			const clock = existing
				? await stripe.testHelpers.testClocks.retrieve(existing.clockId)
				: await stripe.testHelpers.testClocks.create({
						frozen_time: anchor,
						name: `${state.runId} cost ${cost}`,
					});
			if (!existing) state.clocks.push(clock.id);
			await save();
			const accountId = `${state.runId}_cost_${index}`;
			const customer = existing
				? await stripe.customers.retrieve(existing.customerId)
				: await stripe.customers.create({
						test_clock: clock.id,
						name: `Zuse sandbox cost ${cost}`,
						address: {
							country: "US",
							state: "OR",
							city: "Portland",
							postal_code: "97201",
							line1: "123 Test Street",
						},
						payment_method: "pm_card_visa",
						invoice_settings: { default_payment_method: "pm_card_visa" },
						metadata: { account_id: accountId, zuse_test_run: state.runId },
					});
			if (!existing) state.customers.push(customer.id);
			await save();
			await persistence.reserveCustomer(accountId);
			await persistence.linkCustomer(accountId, customer.id);
			const sub = existing
				? await stripe.subscriptions.retrieve(existing.subscriptionId)
				: await stripe.subscriptions.create({
						customer: customer.id,
						items: [
							{ price: state.basePriceId, quantity: 1 },
							{ price: state.overagePriceId },
						],
						automatic_tax: { enabled: true },
						metadata: {
							account_id: accountId,
							offer_id: "cloud-workspace-standard-v1",
							zuse_test_run: state.runId,
						},
					});
			if (!existing) state.subscriptions.push(sub.id);
			const fixture = existing ?? {
				accountId,
				customerId: customer.id,
				subscriptionId: sub.id,
				clockId: clock.id,
				cost,
				expectedCents,
				periodStartMs: sub.items.data[0].current_period_start * 1000,
				periodEndMs: sub.items.data[0].current_period_end * 1000,
			};
			if (!existing) state.fixtures.push(fixture);
			await save();
			assert.equal(sub.status, "active");
			await waitFor(
				"subscription webhook entitlement",
				async () =>
					(
						await db.query(
							"SELECT * FROM api_entitlements WHERE account_id=$1 AND provider='stripe'",
							[accountId],
						)
					).rows[0],
			);
			const period = await run(
				billing.currentPeriod(accountId, anchor * 1000 + 120000),
			);
			assert(period, "Webhook must establish the billing period");
			const batch = {
				provider: "sandbox-fixture",
				eventId: accountId,
				providerExecutionId: accountId,
				finalizedAtMs: anchor * 1000 + 120000,
				usage: [
					{
						entryId: accountId,
						accountId,
						periodId: period.periodId,
						resourceKind: "workspace",
						resourceId: accountId,
						provider: "sandbox-fixture",
						providerExecutionId: accountId,
						startedAt: anchor * 1000 + 60000,
						endedAt: anchor * 1000 + 120000,
						vcpuCount: 2,
						memoryMib: 8192,
						providerCostMicros: cost,
						status: "confirmed",
						nowMs: anchor * 1000 + 120000,
					},
				],
			};
			await run(
				billing.recordProviderEvent({
					provider: batch.provider,
					eventId: batch.eventId,
					type: "completed",
					payload: {},
					receivedAtMs: Date.now(),
					expiresAtMs: Date.now() + 86400000,
				}),
			);
			await run(billing.recordProviderExecutionBatch(batch));
			await run(billing.recordProviderExecutionBatch(batch));
			const summary = await run(billing.summary(period));
			assert.equal(
				Math.round(summary.overageChargeMicros / 10000),
				expectedCents,
			);
			assert.equal(summary.includedUsedMicros, Math.min(cost, 35000000));
			logicalNow = Date.now();
			await run(flushCloudBillingOutbox(Date.now(), 25));
			const pending = await run(billing.pendingOutbox(Date.now(), 25));
			assert.equal(
				pending.filter((o) => o.accountId === accountId).length,
				0,
				"Exports must be acknowledged",
			);
			if (expectedCents > 0) {
				await waitFor(
					"Stripe asynchronous meter aggregation",
					async () =>
						(await Effect.runPromise(
							adapter.reconcileMeter({
								accountId,
								meterId: state.meterId,
								periodStartMs: fixture.periodStartMs,
								periodEndMs: fixture.periodEndMs,
							}),
						)) === expectedCents,
				);
			}
			await record(`allowance, cap and real meter: cost ${cost / 1000000}`, {
				expectedCents,
				ledgerCents: Math.round(summary.overageChargeMicros / 10000),
				duplicateSettlement: "no additional charge",
			});
			await stripe.testHelpers.testClocks.advance(clock.id, {
				frozen_time: fixture.periodEndMs / 1000,
			});
			await waitFor(
				"clock advancement",
				async () =>
					(await stripe.testHelpers.testClocks.retrieve(clock.id)).status ===
					"ready",
			);
			const invoice = await waitFor("renewal invoice", async () => {
				const invoices = await stripe.invoices.list({
					customer: customer.id,
					subscription: sub.id,
					limit: 10,
				});
				return invoices.data.find(
					(i) => i.billing_reason === "subscription_cycle",
				);
			});
			let current = await stripe.invoices.retrieve(invoice.id);
			if (current.status === "draft")
				current = await stripe.invoices.finalizeInvoice(invoice.id);
			if (current.status === "open")
				current = await stripe.invoices.pay(invoice.id);
			assert.equal(current.status, "paid");
			assert.equal(current.total, 4000 + expectedCents);
			fixture.invoiceId = current.id;
			fixture.invoiceTotal = current.total;
			await save();
			await record(`finalized and paid invoice: cost ${cost / 1000000}`, {
				invoiceId: current.id,
				expectedTotalCents: 4000 + expectedCents,
				actualTotalCents: current.total,
			});
		}
		const fixture = state.fixtures[2];
		logicalNow = Date.now();
		await assert.rejects(
			Effect.runPromise(
				adapter.reportMeterEvent({
					accountId: fixture.accountId,
					eventName: "zuse_cloud_overage_cent",
					units: 1,
					idempotencyKey: `${state.runId}_late_finalized`,
					occurredAtMs: fixture.periodStartMs + 180000,
					metadata: {
						provider_subscription_id: fixture.subscriptionId,
						period_start_ms: String(fixture.periodStartMs),
						period_end_ms: String(fixture.periodEndMs),
					},
				}),
			),
			(error) => error.code === "reconciliation-required",
		);
		await record("late finalized-invoice usage stays unresolved", {
			extraCharge: 0,
		});
		const portal = await Effect.runPromise(
			adapter.customerPortal(fixture.accountId),
		);
		assert(portal.startsWith("https://billing.stripe.com/"));
		await record("real customer portal session", {
			customerId: fixture.customerId,
		});
		const declining = state.fixtures[0];
		const method = await stripe.paymentMethods.attach(
			"pm_card_chargeCustomerFail",
			{ customer: declining.customerId },
		);
		await stripe.customers.update(declining.customerId, {
			invoice_settings: { default_payment_method: method.id },
		});
		const invoice = await stripe.invoices.create({
			customer: declining.customerId,
			subscription: declining.subscriptionId,
			auto_advance: false,
		});
		await stripe.invoiceItems.create({
			customer: declining.customerId,
			invoice: invoice.id,
			amount: 100,
			currency: "usd",
			description: "Zuse sandbox payment failure test",
		});
		await stripe.invoices.finalizeInvoice(invoice.id);
		await assert.rejects(
			stripe.invoices.pay(invoice.id),
			(error) => error.type === "StripeCardError",
		);
		assert.equal((await stripe.invoices.retrieve(invoice.id)).status, "open");
		const working = await stripe.paymentMethods.attach("pm_card_visa", {
			customer: declining.customerId,
		});
		await stripe.customers.update(declining.customerId, {
			invoice_settings: { default_payment_method: working.id },
		});
		assert.equal((await stripe.invoices.pay(invoice.id)).status, "paid");
		await record("failed payment and successful retry", {
			invoiceId: invoice.id,
		});
		await Effect.runPromise(adapter.cancel(declining.subscriptionId));
		await Effect.runPromise(adapter.cancel(declining.subscriptionId));
		await waitFor(
			"cancellation entitlement",
			async () =>
				(
					await db.query(
						"SELECT status FROM api_entitlements WHERE account_id=$1 AND provider='stripe'",
						[declining.accountId],
					)
				).rows[0]?.status === "ended",
		);
		await record("real cancellation and idempotent retry", {
			subscriptionId: declining.subscriptionId,
		});
	} else if (command === "faults") {
		const events = (await readFile(`${directory}/webhook-events.jsonl`, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const accepted = events.find(
			(event) =>
				event.status === 200 &&
				JSON.parse(event.body).type === "customer.subscription.created",
		);
		assert(accepted, "An actual Stripe delivery is required for replay tests");
		const webhookUrl = `${state.publicUrl}/v1/billing/webhook/stripe`;
		const countBefore = Number(
			(await db.query("SELECT COUNT(*) FROM api_billing_events")).rows[0].count,
		);
		const forged = await fetch(webhookUrl, {
			method: "POST",
			headers: { "stripe-signature": "t=1,v1=forged" },
			body: accepted.body,
		});
		assert.equal(forged.status, 401);
		assert.equal(
			Number(
				(await db.query("SELECT COUNT(*) FROM api_billing_events")).rows[0]
					.count,
			),
			countBefore,
		);
		const signature = await stripe.webhooks.generateTestHeaderStringAsync({
			payload: accepted.body,
			secret: state.webhookSecret,
		});
		const replies = await Promise.all(
			Array.from({ length: 8 }, () =>
				fetch(webhookUrl, {
					method: "POST",
					headers: { "stripe-signature": signature },
					body: accepted.body,
				}).then(async (response) => ({
					status: response.status,
					body: await response.json(),
				})),
			),
		);
		assert(
			replies.every(
				(reply) => reply.status === 200 && reply.body.duplicate === true,
			),
		);
		assert.equal(
			Number(
				(await db.query("SELECT COUNT(*) FROM api_billing_events")).rows[0]
					.count,
			),
			countBefore,
		);
		const oldEvent = JSON.parse(accepted.body);
		const oldSubscription = await stripe.subscriptions.retrieve(
			oldEvent.data.object.id,
		);
		if (oldSubscription.status === "canceled") {
			assert.equal(
				(
					await db.query(
						"SELECT status FROM api_entitlements WHERE provider_subscription_id=$1",
						[oldSubscription.id],
					)
				).rows[0].status,
				"ended",
			);
		}
		await record(
			"invalid signature, eight duplicate deliveries and stale event replay",
			{ deliveryCount: replies.length, additionalBillingEvents: 0 },
		);
		const fixture = state.fixtures[2];
		const outbox = (
			await db.query(
				"SELECT * FROM api_cloud_billing_outbox WHERE account_id=$1 AND acknowledged_at IS NOT NULL LIMIT 1",
				[fixture.accountId],
			)
		).rows[0];
		assert(outbox);
		const input = {
			accountId: fixture.accountId,
			eventName: "zuse_cloud_overage_cent",
			units: Number(outbox.amount_cents),
			idempotencyKey: outbox.idempotency_key,
			occurredAtMs: Number(outbox.occurred_at),
			metadata: {
				provider_subscription_id: fixture.subscriptionId,
				period_start_ms: String(fixture.periodStartMs),
				period_end_ms: String(fixture.periodEndMs),
			},
		};
		await Promise.all(
			Array.from({ length: 8 }, () =>
				Effect.runPromise(adapter.reportMeterEvent(input)),
			),
		);
		assert.equal(
			await Effect.runPromise(
				adapter.reconcileMeter({
					accountId: fixture.accountId,
					meterId: state.meterId,
					periodStartMs: fixture.periodStartMs,
					periodEndMs: fixture.periodEndMs,
				}),
			),
			fixture.expectedCents,
		);
		await record(
			"durable meter receipts survive a new process and eight concurrent replays",
			{ remoteUnits: fixture.expectedCents, extraUnits: 0 },
		);
		const renewal = state.fixtures[1];
		const badMethod = await stripe.paymentMethods.attach(
			"pm_card_chargeCustomerFail",
			{ customer: renewal.customerId },
		);
		await stripe.customers.update(renewal.customerId, {
			invoice_settings: { default_payment_method: badMethod.id },
		});
		const subscription = await stripe.subscriptions.retrieve(
			renewal.subscriptionId,
		);
		const boundary = subscription.items.data[0].current_period_end;
		await stripe.testHelpers.testClocks.advance(renewal.clockId, {
			frozen_time: boundary,
		});
		await waitFor(
			"failed renewal clock",
			async () =>
				(await stripe.testHelpers.testClocks.retrieve(renewal.clockId))
					.status === "ready",
		);
		let invoice = await waitFor("failed renewal invoice", async () =>
			(
				await stripe.invoices.list({
					customer: renewal.customerId,
					subscription: renewal.subscriptionId,
					limit: 10,
				})
			).data.find(
				(candidate) =>
					candidate.billing_reason === "subscription_cycle" &&
					candidate.created >= boundary,
			),
		);
		if (invoice.status === "draft")
			invoice = await stripe.invoices.finalizeInvoice(invoice.id);
		await assert.rejects(
			stripe.invoices.pay(invoice.id),
			(error) => error.type === "StripeCardError",
		);
		assert.equal(
			(await stripe.subscriptions.retrieve(renewal.subscriptionId)).status,
			"past_due",
		);
		await waitFor("grace entitlement and billing hold", async () => {
			const entitlement = (
				await db.query(
					"SELECT status,period_start FROM api_entitlements WHERE account_id=$1",
					[renewal.accountId],
				)
			).rows[0];
			const period = (
				await db.query(
					"SELECT status FROM api_cloud_billing_periods WHERE account_id=$1 AND period_start=$2",
					[renewal.accountId, boundary * 1000],
				)
			).rows[0];
			return (
				entitlement?.status === "grace" && period?.status === "billing-hold"
			);
		});
		const goodMethod = await stripe.paymentMethods.attach("pm_card_visa", {
			customer: renewal.customerId,
		});
		await stripe.customers.update(renewal.customerId, {
			invoice_settings: { default_payment_method: goodMethod.id },
		});
		assert.equal((await stripe.invoices.pay(invoice.id)).status, "paid");
		await waitFor(
			"recovered renewal entitlement",
			async () =>
				(
					await db.query(
						"SELECT status FROM api_entitlements WHERE account_id=$1",
						[renewal.accountId],
					)
				).rows[0]?.status === "active",
		);
		await record(
			"failed renewal creates grace entitlement and billing hold; payment restores access",
			{ invoiceId: invoice.id },
		);
	} else if (command === "recovery") {
		const anchor = Math.floor((Date.now() - 86400000) / 60000) * 60;
		const clock = await stripe.testHelpers.testClocks.create({
			frozen_time: anchor,
			name: `${state.runId} accepted request lost acknowledgement`,
		});
		state.clocks.push(clock.id);
		await save();
		const accountId = `${state.runId}_recovery`;
		const customer = await stripe.customers.create({
			test_clock: clock.id,
			payment_method: "pm_card_visa",
			invoice_settings: { default_payment_method: "pm_card_visa" },
			address: {
				country: "US",
				state: "OR",
				postal_code: "97201",
				city: "Portland",
				line1: "123 Test Street",
			},
			metadata: { account_id: accountId, zuse_test_run: state.runId },
		});
		state.customers.push(customer.id);
		await save();
		await persistence.reserveCustomer(accountId);
		await persistence.linkCustomer(accountId, customer.id);
		const sub = await stripe.subscriptions.create({
			customer: customer.id,
			items: [
				{ price: state.basePriceId, quantity: 1 },
				{ price: state.overagePriceId },
			],
			automatic_tax: { enabled: true },
			metadata: {
				account_id: accountId,
				offer_id: "cloud-workspace-standard-v1",
			},
		});
		state.subscriptions.push(sub.id);
		await save();
		const start = sub.items.data[0].current_period_start * 1000;
		const end = sub.items.data[0].current_period_end * 1000;
		const input = {
			accountId,
			eventName: "zuse_cloud_overage_cent",
			units: 60,
			idempotencyKey: `${state.runId}_lost_ack`,
			occurredAtMs: start + 120000,
			metadata: {
				provider_subscription_id: sub.id,
				period_start_ms: String(start),
				period_end_ms: String(end),
			},
		};
		const faultyAdapter = makeStripeBillingProvider(
			{
				secretKey: Redacted.make(key),
				webhookSecret: Redacted.make(state.webhookSecret),
				offerPrices: { "cloud-workspace-standard-v1": state.basePriceId },
				cloudOveragePriceId: state.overagePriceId,
				portalReturnUrl: "https://example.com/zuse-sandbox",
			},
			{
				store: {
					...persistence,
					finishDelivery: async (_key, sent) => {
						assert(
							sent,
							"Fault injection must follow a successful remote request",
						);
						throw new Error(
							"Simulated process crash before committing acknowledgement",
						);
					},
				},
			},
		);
		await assert.rejects(
			Effect.runPromise(faultyAdapter.reportMeterEvent(input)),
		);
		const delivery = (
			await db.query(
				"SELECT * FROM api_stripe_meter_deliveries WHERE payload::jsonb->'payload'->>'stripe_customer_id'=$1",
				[customer.id],
			)
		).rows[0];
		assert(delivery && delivery.sent_at === null);
		// Test-only time control: expire the abandoned lease, preserving its key,
		// immutable payload and original first-attempt timestamp.
		await db.query(
			"UPDATE api_stripe_meter_deliveries SET lease_until=0 WHERE delivery_key=$1",
			[delivery.delivery_key],
		);
		await Effect.runPromise(adapter.reportMeterEvent(input));
		await waitFor(
			"deduplicated remote usage after lost acknowledgement",
			async () =>
				(await Effect.runPromise(
					adapter.reconcileMeter({
						accountId,
						meterId: state.meterId,
						periodStartMs: start,
						periodEndMs: end,
					}),
				)) === 60,
		);
		assert(
			(
				await db.query(
					"SELECT sent_at FROM api_stripe_meter_deliveries WHERE delivery_key=$1",
					[delivery.delivery_key],
				)
			).rows[0].sent_at,
		);
		await record(
			"Stripe accepted usage, local acknowledgement failed, same-key retry charged once",
			{ remoteUnits: 60, extraUnits: 0 },
		);
		const capped = state.fixtures[3];
		const period = await run(
			billing.currentPeriod(capped.accountId, capped.periodStartMs + 120000),
		);
		const reservation = await run(
			billing.reserveCost({
				periodId: period.periodId,
				accountId: capped.accountId,
				resourceKind: "workspace",
				resourceId: `${state.runId}_cap_rejected`,
				provider: "sandbox-fixture",
				providerCostMicros: 1000000,
				startedAtMs: capped.periodStartMs + 180000,
				vcpuCount: 2,
				memoryMib: 8192,
				nowMs: capped.periodStartMs + 180000,
				expiresAtMs: capped.periodStartMs + 240000,
			}),
		);
		assert.equal(reservation.accepted, false);
		await record("exhausted cap rejects another compute reservation", {
			accepted: false,
		});
		await Effect.runPromise(adapter.cancel(capped.subscriptionId));
		await waitFor(
			"canceled capped fixture",
			async () =>
				(
					await db.query(
						"SELECT status FROM api_entitlements WHERE account_id=$1",
						[capped.accountId],
					)
				).rows[0]?.status === "ended",
		);
		const deliveries = (
			await readFile(`${directory}/webhook-events.jsonl`, "utf8")
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const original = deliveries.find((delivery) => {
			const event = JSON.parse(delivery.body);
			return (
				event.type === "customer.subscription.created" &&
				event.data.object.id === capped.subscriptionId
			);
		});
		assert(original);
		const originalId = JSON.parse(original.body).id;
		// Simulate a previously missed event arriving after cancellation.
		await db.query(
			"DELETE FROM api_billing_events WHERE provider='stripe' AND event_id=$1",
			[originalId],
		);
		const signature = await stripe.webhooks.generateTestHeaderStringAsync({
			payload: original.body,
			secret: state.webhookSecret,
		});
		const replay = await fetch(`${state.publicUrl}/v1/billing/webhook/stripe`, {
			method: "POST",
			headers: { "stripe-signature": signature },
			body: original.body,
		});
		assert.equal(replay.status, 200);
		assert.equal((await replay.json()).duplicate, false);
		assert.equal(
			(
				await db.query(
					"SELECT status FROM api_entitlements WHERE account_id=$1",
					[capped.accountId],
				)
			).rows[0].status,
			"ended",
		);
		await record(
			"previously missed creation event after cancellation cannot restore access",
			{ entitlementStatus: "ended" },
		);
	} else if (command === "migration") {
		const clock = await stripe.testHelpers.testClocks.create({
			frozen_time: Math.floor(Date.now() / 60000) * 60,
			name: `${state.runId} exact renewal migration`,
		});
		state.clocks.push(clock.id);
		await save();
		const accountId = `${state.runId}_migration`;
		const customer = await stripe.customers.create({
			test_clock: clock.id,
			payment_method: "pm_card_visa",
			invoice_settings: { default_payment_method: "pm_card_visa" },
			address: {
				country: "US",
				state: "OR",
				postal_code: "97201",
				city: "Portland",
				line1: "123 Test Street",
			},
			metadata: { account_id: accountId, zuse_test_run: state.runId },
		});
		state.customers.push(customer.id);
		await save();
		await persistence.reserveCustomer(accountId);
		await persistence.linkCustomer(accountId, customer.id);
		const item = {
			accountId,
			polarSubscriptionId: `${state.runId}_polar_fixture`,
			stripeCustomerId: customer.id,
			offerId: "cloud-workspace-standard-v1",
			renewalAtMs: (clock.frozen_time + 86400) * 1000,
		};
		const params = migrationScheduleParams(
			item,
			state.basePriceId,
			state.overagePriceId,
		);
		const key = `${state.runId}_migration_schedule`;
		const schedule = await stripe.subscriptionSchedules.create(params, {
			idempotencyKey: key,
		});
		state.schedules.push(schedule.id);
		await save();
		assert.equal(
			(
				await stripe.subscriptionSchedules.create(params, {
					idempotencyKey: key,
				})
			).id,
			schedule.id,
		);
		assert.equal(schedule.status, "not_started");
		assert.equal(
			(await stripe.invoices.list({ customer: customer.id })).data.length,
			0,
		);
		await stripe.testHelpers.testClocks.advance(clock.id, {
			frozen_time: item.renewalAtMs / 1000,
		});
		await waitFor(
			"scheduled renewal clock",
			async () =>
				(await stripe.testHelpers.testClocks.retrieve(clock.id)).status ===
				"ready",
		);
		const active = await stripe.subscriptionSchedules.retrieve(schedule.id);
		assert.equal(active.status, "active");
		assert.equal(active.current_phase.start_date, item.renewalAtMs / 1000);
		const subscriptionId =
			typeof active.subscription === "string"
				? active.subscription
				: active.subscription.id;
		state.subscriptions.push(subscriptionId);
		await save();
		await waitFor(
			"migration subscription entitlement",
			async () =>
				(
					await db.query(
						"SELECT * FROM api_entitlements WHERE account_id=$1 AND provider='stripe'",
						[accountId],
					)
				).rows[0],
		);
		await record(
			"exact renewal schedule, no immediate invoice and duplicate prevention",
			{ scheduleId: active.id, subscriptionId, renewalAtMs: item.renewalAtMs },
		);
	} else if (command === "migration-finish") {
		const schedule = await stripe.subscriptionSchedules.retrieve(
			state.schedules[0],
		);
		assert.equal(schedule.status, "active");
		const customer = await stripe.customers.retrieve(
			typeof schedule.customer === "string"
				? schedule.customer
				: schedule.customer.id,
		);
		const clockId =
			typeof customer.test_clock === "string"
				? customer.test_clock
				: customer.test_clock.id;
		const rollbackAccount = `${state.runId}_rollback`;
		const rollbackCustomer = await stripe.customers.create({
			test_clock: clockId,
			payment_method: "pm_card_visa",
			invoice_settings: { default_payment_method: "pm_card_visa" },
			address: {
				country: "US",
				state: "OR",
				postal_code: "97201",
				city: "Portland",
				line1: "123 Test Street",
			},
			metadata: { account_id: rollbackAccount, zuse_test_run: state.runId },
		});
		state.customers.push(rollbackCustomer.id);
		await save();
		const rollback = await stripe.subscriptionSchedules.create(
			migrationScheduleParams(
				{
					accountId: rollbackAccount,
					stripeCustomerId: rollbackCustomer.id,
					polarSubscriptionId: `${state.runId}_rollback_polar`,
					offerId: "cloud-workspace-standard-v1",
					renewalAtMs: (schedule.current_phase.end_date - 86400) * 1000,
				},
				state.basePriceId,
				state.overagePriceId,
			),
		);
		state.schedules.push(rollback.id);
		await save();
		assert.equal(rollback.status, "not_started");
		await stripe.subscriptionSchedules.cancel(rollback.id);
		await stripe.testHelpers.testClocks.advance(clockId, {
			frozen_time: schedule.current_phase.end_date,
		});
		await waitFor(
			"migration release clock",
			async () =>
				(await stripe.testHelpers.testClocks.retrieve(clockId)).status ===
				"ready",
		);
		const released = await stripe.subscriptionSchedules.retrieve(schedule.id);
		assert.equal(released.status, "released");
		const subscriptionId =
			typeof released.released_subscription === "string"
				? released.released_subscription
				: released.released_subscription.id;
		assert(state.subscriptions.includes(subscriptionId));
		assert.equal(
			(await stripe.subscriptions.retrieve(subscriptionId)).status,
			"active",
		);
		assert.equal(
			(await stripe.subscriptionSchedules.retrieve(rollback.id)).status,
			"canceled",
		);
		assert.equal(
			(await stripe.invoices.list({ customer: rollbackCustomer.id })).data
				.length,
			0,
		);
		assert.equal(
			(await stripe.subscriptions.list({ customer: rollbackCustomer.id })).data
				.length,
			0,
		);
		await record(
			"migration releases into ordinary subscription; pre-renewal rollback creates no invoice",
			{
				scheduleId: schedule.id,
				subscriptionId,
				rollbackScheduleId: rollback.id,
				rollbackInvoices: 0,
			},
		);
	} else if (command === "cleanup") {
		// Preserve customers, paid invoices and completed clocks for inspection.
		// Stop this run's destinations and subscriptions, never unrelated objects.
		for (const id of state.schedules) {
			const schedule = await stripe.subscriptionSchedules.retrieve(id);
			if (["active", "not_started"].includes(schedule.status))
				await stripe.subscriptionSchedules.cancel(id, {
					invoice_now: false,
					prorate: false,
				});
		}
		const checkoutSubscriptions = [];
		for (const id of state.checkoutSessions) {
			const checkout = await stripe.checkout.sessions.retrieve(id);
			if (checkout.subscription)
				checkoutSubscriptions.push(
					typeof checkout.subscription === "string"
						? checkout.subscription
						: checkout.subscription.id,
				);
			else if (checkout.status === "open")
				await stripe.checkout.sessions.expire(id);
		}
		for (const id of new Set([
			...state.subscriptions,
			...checkoutSubscriptions,
		])) {
			const sub = await stripe.subscriptions.retrieve(id);
			if (!["canceled", "incomplete_expired"].includes(sub.status))
				await stripe.subscriptions.cancel(id, {
					invoice_now: false,
					prorate: false,
				});
		}
		if (state.testTaxRegistrationId) {
			const registration = await stripe.tax.registrations.retrieve(
				state.testTaxRegistrationId,
			);
			if (registration.status !== "expired")
				await stripe.tax.registrations.update(registration.id, {
					expires_at: "now",
				});
		}
		if (state.webhookId && !state.webhookDeleted) {
			await stripe.webhookEndpoints.del(state.webhookId);
			state.webhookDeleted = true;
		}
		delete state.webhookSecret;
		await record(
			"temporary webhook removed, test subscriptions canceled and test tax registration expired",
			{
				invoicesRetained: true,
				sandboxTaxSettingsRetained: state.testTaxSettingsConfigured === true,
			},
		);
	} else if (command === "inspect") {
		const checkout = state.checkoutSessionId
			? await stripe.checkout.sessions.retrieve(state.checkoutSessionId, {
					expand: ["subscription", "invoice"],
				})
			: null;
		if (checkout?.payment_status === "paid") {
			const owned = await Effect.runPromise(
				adapter.getCheckout({
					accountId: state.checkoutAccountId,
					checkoutId: checkout.id,
				}),
			);
			assert.equal(owned.status, "paid");
			assert.equal(
				await Effect.runPromise(
					adapter.getCheckout({
						accountId: "different-account",
						checkoutId: checkout.id,
					}),
				),
				null,
			);
			await record("hosted checkout payment, tax and receipt ownership", {
				sessionId: checkout.id,
				amountTotalCents: checkout.amount_total,
				taxCents: checkout.total_details.amount_tax,
				automaticTaxStatus: checkout.automatic_tax.status,
			});
		}
		console.log(
			JSON.stringify(
				{
					results: state.results,
					checkoutStatus: checkout?.status,
					checkoutPaymentStatus: checkout?.payment_status,
					entitlements: (
						await db.query(
							"SELECT account_id,provider,status,period_start,paid_through FROM api_entitlements",
						)
					).rows,
				},
				null,
				2,
			),
		);
	} else
		throw new Error(
			"Use prepare, serve, connect, checkout, run, faults, recovery, migration, migration-finish, inspect or cleanup",
		);
} finally {
	await db.end();
	await runtime.dispose();
}
