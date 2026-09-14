-- Box (box.ascii.dev) provider pricing. Published rates: small (2 vCPU/4 GiB)
-- $0.018/h, default (4/8) $0.036/h, large (8/16) $0.072/h — all satisfied by
-- one linear rate pair: 2150 nano-USD per vCPU-second + 175 nano-USD per
-- GiB-second (e.g. small: (2*2150 + 4*175) * 3600 = $0.018/h).
INSERT INTO "api_provider_price_schedule" ("provider","version","effective_at","base_nano_usd_per_second","cpu_nano_usd_per_second","memory_nano_usd_per_gib_second","storage_nano_usd_per_gib_second","created_at") VALUES ('box','box-public-2026-08-17',0,0,2150,175,0,0) ON CONFLICT DO NOTHING;
-- Billing window pairing looks up the opening box.ready event by resource id.
CREATE INDEX IF NOT EXISTS "api_provider_usage_events_resource_idx" ON "api_provider_usage_events" ("provider","provider_resource_id","type","received_at");
