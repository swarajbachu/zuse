ALTER TABLE "relay_environments" ADD COLUMN "tunnel_id" text;--> statement-breakpoint
ALTER TABLE "relay_environments" ADD COLUMN "dns_record_id" text;--> statement-breakpoint
ALTER TABLE "relay_environments" ADD COLUMN "tunnel_status" text;--> statement-breakpoint
ALTER TABLE "relay_environments" ADD CONSTRAINT "relay_environments_tunnel_status_check" CHECK ("relay_environments"."tunnel_status" IS NULL OR "relay_environments"."tunnel_status" IN ('reserved', 'ready'));