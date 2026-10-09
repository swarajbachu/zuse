-- Old Workers omit occurred_at from their Polar outbox inserts. Keep those
-- inserts working during the database-first rollout. New Workers always send
-- the immutable, period-clamped event time explicitly.
ALTER TABLE api_cloud_billing_outbox ALTER COLUMN occurred_at
  SET DEFAULT floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
