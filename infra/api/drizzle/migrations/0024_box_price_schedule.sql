-- Box (box.ascii.dev) provider pricing. Published rates: small (2 vCPU/4 GiB)
-- $0.018/h, default (4/8) $0.036/h, large (8/16) $0.072/h — all satisfied by
-- one linear rate pair: 2150 nano-USD per vCPU-second + 175 nano-USD per
-- GiB-second (e.g. small: (2*2150 + 4*175) * 3600 = $0.018/h).
INSERT INTO "api_provider_price_schedule" ("provider","version","effective_at","base_nano_usd_per_second","cpu_nano_usd_per_second","memory_nano_usd_per_gib_second","storage_nano_usd_per_gib_second","created_at") VALUES ('box','box-public-2026-08-17',0,0,2150,175,0,0) ON CONFLICT DO NOTHING;
-- Nullable metadata addition does not rewrite the existing event ledger.
ALTER TABLE "api_provider_usage_events" ADD COLUMN IF NOT EXISTS "occurred_at" bigint;
CREATE TABLE IF NOT EXISTS "api_provider_lifecycle_pairs" (
  "provider" text NOT NULL,
  "closing_event_id" text NOT NULL,
  "opening_event_id" text NOT NULL,
  "started_at" bigint NOT NULL,
  PRIMARY KEY ("provider", "closing_event_id"),
  FOREIGN KEY ("provider", "closing_event_id") REFERENCES "api_provider_usage_events" ("provider", "event_id") ON DELETE CASCADE,
  FOREIGN KEY ("provider", "opening_event_id") REFERENCES "api_provider_usage_events" ("provider", "event_id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "api_provider_lifecycle_pairs_opening_idx" ON "api_provider_lifecycle_pairs" ("provider", "opening_event_id");
-- The existing-ledger lookup index is built CONCURRENTLY by migrate-database.mjs.
