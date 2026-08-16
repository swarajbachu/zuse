ALTER TABLE "relay_entitlements" ADD COLUMN IF NOT EXISTS "period_start" bigint;
CREATE TABLE IF NOT EXISTS "relay_cloud_billing_periods" (
 "period_id" text PRIMARY KEY, "account_id" text NOT NULL, "provider_subscription_id" text,
 "status" text NOT NULL, "currency" text DEFAULT 'USD' NOT NULL, "period_start" bigint NOT NULL,
 "period_end" bigint NOT NULL, "base_price_micros" bigint NOT NULL,
 "included_provider_cost_micros" bigint NOT NULL, "markup_basis_points" bigint NOT NULL, "price_catalog_version" text NOT NULL,
 "overage_cap_micros" bigint NOT NULL,
 "created_at" bigint NOT NULL, "updated_at" bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "relay_cloud_billing_period_account_start_idx" ON "relay_cloud_billing_periods" ("account_id","period_start");
CREATE INDEX IF NOT EXISTS "relay_cloud_billing_period_active_idx" ON "relay_cloud_billing_periods" ("account_id","period_end");
CREATE TABLE IF NOT EXISTS "relay_provider_price_schedule" (
 "provider" text NOT NULL, "version" text NOT NULL, "effective_at" bigint NOT NULL,
 "base_nano_usd_per_second" bigint DEFAULT 0 NOT NULL, "cpu_nano_usd_per_second" bigint NOT NULL, "memory_nano_usd_per_gib_second" bigint NOT NULL,
 "storage_nano_usd_per_gib_second" bigint DEFAULT 0 NOT NULL, "created_at" bigint NOT NULL,
 PRIMARY KEY ("provider","version")
);
CREATE UNIQUE INDEX IF NOT EXISTS "relay_provider_price_schedule_effective_idx" ON "relay_provider_price_schedule" ("provider","effective_at");
INSERT INTO "relay_provider_price_schedule" ("provider","version","effective_at","base_nano_usd_per_second","cpu_nano_usd_per_second","memory_nano_usd_per_gib_second","storage_nano_usd_per_gib_second","created_at") VALUES ('e2b','e2b-public-2026-08-14',0,0,14000,4500,0,0) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS "relay_provider_usage_events" (
 "event_id" text NOT NULL, "provider" text NOT NULL, "type" text NOT NULL,
 "provider_resource_id" text, "payload" jsonb NOT NULL, "received_at" bigint NOT NULL,
 "expires_at" bigint NOT NULL, PRIMARY KEY ("provider","event_id")
);
CREATE INDEX IF NOT EXISTS "relay_provider_usage_events_expiry_idx" ON "relay_provider_usage_events" ("expires_at");
CREATE TABLE IF NOT EXISTS "relay_provider_event_finalizations" (
 "provider" text NOT NULL, "event_id" text NOT NULL, "finalized_at" bigint NOT NULL,
 "expires_at" bigint NOT NULL, PRIMARY KEY ("provider","event_id")
);
CREATE INDEX IF NOT EXISTS "relay_provider_event_finalizations_expiry_idx" ON "relay_provider_event_finalizations" ("expires_at");
CREATE TABLE IF NOT EXISTS "relay_provider_event_deliveries" (
 "provider" text NOT NULL, "delivery_id" text NOT NULL, "event_id" text NOT NULL,
 "source" text NOT NULL, "status" text NOT NULL, "received_at" bigint NOT NULL,
 PRIMARY KEY ("provider","delivery_id")
);
CREATE INDEX IF NOT EXISTS "relay_provider_event_deliveries_event_idx" ON "relay_provider_event_deliveries" ("provider","event_id");
CREATE TABLE IF NOT EXISTS "relay_cloud_billing_usage" (
 "entry_id" text PRIMARY KEY, "period_id" text NOT NULL, "account_id" text NOT NULL,
 "resource_kind" text NOT NULL, "resource_id" text NOT NULL, "provider" text NOT NULL,
 "provider_event_id" text, "provider_execution_id" text, "started_at" bigint NOT NULL,
 "ended_at" bigint NOT NULL, "vcpu_count" bigint NOT NULL, "memory_mib" bigint NOT NULL,
 "provider_cost_micros" bigint NOT NULL, "status" text NOT NULL, "created_at" bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "relay_cloud_billing_usage_provider_event_idx" ON "relay_cloud_billing_usage" ("provider","provider_event_id");
CREATE INDEX IF NOT EXISTS "relay_cloud_billing_usage_period_idx" ON "relay_cloud_billing_usage" ("period_id","started_at");
CREATE TABLE IF NOT EXISTS "relay_cloud_billing_reservations" (
 "period_id" text NOT NULL, "account_id" text NOT NULL, "resource_kind" text NOT NULL,
 "resource_id" text NOT NULL, "provider" text NOT NULL, "provider_cost_micros" bigint NOT NULL,
 "started_at" bigint NOT NULL, "vcpu_count" bigint NOT NULL, "memory_mib" bigint NOT NULL,
 "expires_at" bigint NOT NULL, "updated_at" bigint NOT NULL,
 PRIMARY KEY ("period_id","resource_kind","resource_id")
);
CREATE INDEX IF NOT EXISTS "relay_cloud_billing_reservations_expiry_idx" ON "relay_cloud_billing_reservations" ("expires_at");
CREATE TABLE IF NOT EXISTS "relay_cloud_billing_cap_commands" (
 "period_id" text NOT NULL, "idempotency_key" text NOT NULL,
 "overage_cap_micros" bigint NOT NULL, "created_at" bigint NOT NULL,
 PRIMARY KEY ("period_id","idempotency_key")
);
CREATE TABLE IF NOT EXISTS "relay_cloud_billing_ledger" (
 "entry_id" text PRIMARY KEY, "period_id" text NOT NULL, "account_id" text NOT NULL,
 "kind" text NOT NULL, "amount_micros" bigint NOT NULL, "source_id" text NOT NULL,
 "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL, "occurred_at" bigint NOT NULL, "created_at" bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "relay_cloud_billing_ledger_source_idx" ON "relay_cloud_billing_ledger" ("kind","source_id");
CREATE INDEX IF NOT EXISTS "relay_cloud_billing_ledger_period_idx" ON "relay_cloud_billing_ledger" ("period_id","occurred_at");
CREATE TABLE IF NOT EXISTS "relay_cloud_billing_outbox" (
 "outbox_id" text PRIMARY KEY, "period_id" text NOT NULL, "account_id" text NOT NULL,
 "provider" text NOT NULL, "amount_cents" bigint NOT NULL, "idempotency_key" text NOT NULL,
 "attempt_count" bigint DEFAULT 0 NOT NULL, "next_attempt_at" bigint NOT NULL,
 "acknowledged_at" bigint, "last_error" text, "created_at" bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "relay_cloud_billing_outbox_idempotency_idx" ON "relay_cloud_billing_outbox" ("provider","idempotency_key");
CREATE TABLE IF NOT EXISTS "relay_cloud_billing_meter_reconciliations" (
 "reconciliation_id" text PRIMARY KEY, "period_id" text NOT NULL, "provider" text NOT NULL,
 "expected_units" bigint NOT NULL, "observed_units" bigint NOT NULL, "created_at" bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "relay_cloud_billing_meter_reconciliation_period_idx" ON "relay_cloud_billing_meter_reconciliations" ("period_id","created_at");
CREATE TABLE IF NOT EXISTS "relay_platform_costs" (
 "cost_id" text PRIMARY KEY, "vendor" text NOT NULL, "kind" text NOT NULL,
 "amount_micros" bigint NOT NULL, "currency" text DEFAULT 'USD' NOT NULL, "external_id" text,
 "period_start" bigint NOT NULL, "period_end" bigint NOT NULL,
 "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL, "created_at" bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "relay_platform_cost_vendor_external_idx" ON "relay_platform_costs" ("vendor","external_id");
CREATE TABLE IF NOT EXISTS "relay_provider_statement_totals" (
 "statement_id" text PRIMARY KEY, "provider" text NOT NULL, "external_id" text NOT NULL,
 "amount_micros" bigint NOT NULL, "currency" text DEFAULT 'USD' NOT NULL,
 "period_start" bigint NOT NULL, "period_end" bigint NOT NULL,
 "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL, "created_at" bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "relay_provider_statement_external_idx" ON "relay_provider_statement_totals" ("provider","external_id");
