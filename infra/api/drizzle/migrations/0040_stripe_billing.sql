-- Existing periods and queued charges retain their Polar ownership. A checkout
-- default change must never reroute historical invoice usage.
ALTER TABLE api_cloud_billing_periods ADD COLUMN billing_provider text NOT NULL DEFAULT 'polar';
UPDATE api_cloud_billing_periods SET billing_provider='manual' WHERE status='manual';
ALTER TABLE api_cloud_billing_outbox ADD COLUMN occurred_at bigint;
UPDATE api_cloud_billing_outbox o SET occurred_at=GREATEST(p.period_start, LEAST(o.created_at, p.period_end-1000)) FROM api_cloud_billing_periods p WHERE p.period_id=o.period_id;
UPDATE api_cloud_billing_outbox SET occurred_at=created_at WHERE occurred_at IS NULL;
ALTER TABLE api_cloud_billing_outbox ALTER COLUMN occurred_at SET NOT NULL;
CREATE TABLE api_stripe_customers (
 account_id text PRIMARY KEY,
 customer_id text UNIQUE,
 created_at bigint NOT NULL
);
CREATE TABLE api_stripe_meter_deliveries (
 delivery_key text PRIMARY KEY,
 payload text NOT NULL,
 first_attempt_at bigint NOT NULL,
 lease_until bigint NOT NULL,
 sent_at bigint
);

CREATE TABLE api_stripe_subscription_migrations (
 polar_subscription_id text PRIMARY KEY,
 account_id text NOT NULL UNIQUE,
 customer_id text NOT NULL UNIQUE,
 payload text NOT NULL,
 first_attempt_at bigint NOT NULL,
 schedule_id text UNIQUE
);
