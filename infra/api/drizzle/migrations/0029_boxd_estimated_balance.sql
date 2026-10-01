ALTER TABLE api_cloud_billing_usage ADD COLUMN provider_sandbox_id text;
ALTER TABLE api_cloud_billing_usage ADD COLUMN measurement text NOT NULL DEFAULT 'provider';
ALTER TABLE api_cloud_billing_usage ADD COLUMN price_version text;
ALTER TABLE api_cloud_billing_usage ADD CONSTRAINT api_usage_estimate_valid CHECK (
 measurement IN ('provider', 'estimated') AND
 (measurement <> 'estimated' OR (status = 'provisional' AND provider_sandbox_id IS NOT NULL AND price_version IS NOT NULL AND ended_at > started_at AND provider_cost_micros >= 0))
);
CREATE INDEX api_cloud_billing_usage_settlement_idx ON api_cloud_billing_usage
 (period_id, provider, provider_sandbox_id, resource_kind, resource_id, started_at, ended_at);
--> statement-breakpoint
-- Preserve original estimates for audit. Only their uncovered portions reduce balance.
-- Multiranges union overlaps before subtraction, including partial settlement windows.
CREATE VIEW api_cloud_billing_estimate_balances AS
SELECT e.*,
 FLOOR(e.provider_cost_micros::numeric * remaining.duration_ms / (e.ended_at - e.started_at))::bigint AS outstanding_cost_micros
FROM api_cloud_billing_usage e
CROSS JOIN LATERAL (
 SELECT COALESCE(SUM(upper(r) - lower(r)), 0) AS duration_ms
 FROM unnest(
  int8multirange(int8range(e.started_at, e.ended_at, '[)')) -
  COALESCE((SELECT range_agg(int8range(GREATEST(c.started_at,e.started_at), LEAST(c.ended_at,e.ended_at), '[)'))
   FROM api_cloud_billing_usage c
   WHERE c.period_id=e.period_id AND c.account_id=e.account_id
    AND c.provider=e.provider AND c.provider_sandbox_id=e.provider_sandbox_id
    AND c.resource_kind=e.resource_kind AND c.resource_id=e.resource_id
    AND c.measurement='provider' AND c.status IN ('confirmed','corrected')
    AND c.started_at < e.ended_at AND c.ended_at > e.started_at
  ), '{}'::int8multirange)
 ) AS r
) remaining
WHERE e.measurement='estimated';
