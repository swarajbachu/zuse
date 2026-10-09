-- Additive, database-first rollout: legacy reservations retain their original keys.
ALTER TABLE api_stripe_customers ADD COLUMN generation integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Preserve created_at so older Workers cannot replay an expired generation during rollout.
ALTER TABLE api_stripe_customers ADD COLUMN reservation_created_at bigint;
--> statement-breakpoint
CREATE TABLE api_cloud_billing_meter_reconciliation_attempts (
 period_id text NOT NULL,
 provider text NOT NULL,
 attempted_at bigint NOT NULL,
 PRIMARY KEY (period_id, provider)
);
