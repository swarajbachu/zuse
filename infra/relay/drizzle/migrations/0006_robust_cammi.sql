ALTER TABLE "relay_machines" ADD COLUMN "provider_endpoint_http_base_url" text;--> statement-breakpoint
ALTER TABLE "relay_machines" ADD COLUMN "provider_endpoint_ws_base_url" text;--> statement-breakpoint
UPDATE "relay_machines"
SET
	"provider_endpoint_http_base_url" = 'https://47837-' || "provider_server_id" || '.' || "provider_endpoint_domain",
	"provider_endpoint_ws_base_url" = 'wss://47837-' || "provider_server_id" || '.' || "provider_endpoint_domain"
WHERE "provider_server_id" IS NOT NULL AND "provider_endpoint_domain" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_machines" DROP COLUMN "provider_endpoint_domain";
