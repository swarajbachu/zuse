-- Keep scheduling fairness separate from the lease that protects an in-flight page.
ALTER TABLE api_stripe_customers ADD COLUMN recovery_lease_until bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Preserve any claims made by the previous Worker during database-first rollout.
UPDATE api_stripe_customers SET recovery_lease_until=recovery_attempted_at+300000
 WHERE customer_id IS NULL AND NOT recovery_complete AND recovery_attempted_at IS NOT NULL;
