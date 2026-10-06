CREATE TABLE api_cloud_snapshot_leases (
 account_id text PRIMARY KEY,
 owner text NOT NULL,
 expires_at bigint NOT NULL
);
CREATE TABLE api_cloud_snapshots (
 provider text NOT NULL CHECK (provider = 'box'),
 snapshot_id text NOT NULL,
 account_id text NOT NULL,
 build_id text NOT NULL,
 state text NOT NULL CHECK (state IN ('creating','retained','deleting','deleted')),
 created_at bigint NOT NULL,
 record jsonb NOT NULL,
 PRIMARY KEY (provider, snapshot_id)
);
CREATE UNIQUE INDEX api_cloud_snapshots_retained_idx ON api_cloud_snapshots(account_id,provider) WHERE state = 'retained';
CREATE INDEX api_cloud_snapshots_account_idx ON api_cloud_snapshots(account_id, state);
CREATE INDEX api_cloud_snapshots_live_idx ON api_cloud_snapshots(state) WHERE state != 'deleted';
CREATE INDEX api_cloud_snapshots_unsettled_idx ON api_cloud_snapshots(account_id) WHERE state = 'deleted' AND (record->>'retainedAtMs')::bigint IS NOT NULL AND COALESCE((record->>'checkpointAtMs')::bigint, (record->>'retainedAtMs')::bigint) < (record->>'stoppedAtMs')::bigint;
CREATE TABLE api_snapshot_price_schedule (
 provider text NOT NULL,
 version text NOT NULL,
 monthly_micros bigint NOT NULL CHECK (monthly_micros >= 0),
 duration_ms bigint NOT NULL CHECK (duration_ms = 2592000000),
 PRIMARY KEY (provider, version)
);
INSERT INTO api_snapshot_price_schedule VALUES ('box','boat-snapshot-2026-10-v1',1700000,2592000000);
CREATE FUNCTION api_snapshot_price_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Snapshot price schedules are immutable; insert a new version';
END;
$$;
CREATE TRIGGER api_snapshot_price_immutable BEFORE UPDATE OR DELETE ON api_snapshot_price_schedule FOR EACH ROW EXECUTE FUNCTION api_snapshot_price_immutable();
-- Backfill exact stored identities only. Start accrual at migration time, never at historical creation.
INSERT INTO api_cloud_snapshots (provider, snapshot_id, account_id, build_id, state, created_at, record)
SELECT provider, snapshot_id, account_id, build_id,
 CASE WHEN state = 'ready' AND rank = 1 THEN 'retained' WHEN state IN ('building','sanitizing') THEN 'creating' ELSE 'deleting' END,
 created_at,
 jsonb_strip_nulls(jsonb_build_object(
  'snapshotId', snapshot_id, 'provider', provider, 'accountId', account_id, 'buildId', build_id,
  'state', CASE WHEN state = 'ready' AND rank = 1 THEN 'retained' WHEN state IN ('building','sanitizing') THEN 'creating' ELSE 'deleting' END,
  'createdAtMs', created_at,
  'retainedAtMs', CASE WHEN state = 'ready' AND rank = 1 THEN floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint END,
  'stoppedAtMs', CASE WHEN state NOT IN ('building','sanitizing') AND (state != 'ready' OR rank != 1) THEN floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint END,
  'remainder', 0, 'attempts', 0, 'nextAttemptAtMs', 0))
FROM (SELECT *, row_number() OVER (PARTITION BY account_id, provider ORDER BY CASE WHEN state = 'ready' THEN 0 ELSE 1 END, updated_at DESC, build_id DESC) AS rank
 FROM api_cloud_project_builds WHERE provider = 'box' AND snapshot_id IS NOT NULL) builds
ON CONFLICT DO NOTHING;
