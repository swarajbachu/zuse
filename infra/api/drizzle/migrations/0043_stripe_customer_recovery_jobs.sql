-- Durable, bounded customer lookup jobs keep full scans out of checkout requests.
ALTER TABLE api_stripe_customers
 ADD COLUMN recovery_cursor text,
 ADD COLUMN recovery_matches jsonb NOT NULL DEFAULT '[]'::jsonb,
 ADD COLUMN recovery_complete boolean NOT NULL DEFAULT false,
 ADD COLUMN recovery_attempted_at bigint;
-- The pending-recovery index is built CONCURRENTLY by migrate-database.mjs.
