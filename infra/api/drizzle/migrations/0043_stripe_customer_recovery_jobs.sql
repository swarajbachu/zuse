-- Durable, bounded customer lookup jobs keep full scans out of checkout requests.
ALTER TABLE api_stripe_customers
 ADD COLUMN recovery_cursor text,
 ADD COLUMN recovery_matches jsonb NOT NULL DEFAULT '[]'::jsonb,
 ADD COLUMN recovery_complete boolean NOT NULL DEFAULT false,
 ADD COLUMN recovery_attempted_at bigint;
--> statement-breakpoint
CREATE INDEX api_stripe_customer_recovery_pending_idx
 ON api_stripe_customers (COALESCE(recovery_attempted_at, 0), account_id)
 WHERE customer_id IS NULL AND NOT recovery_complete;
