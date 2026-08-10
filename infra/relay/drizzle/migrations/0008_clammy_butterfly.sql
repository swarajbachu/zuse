ALTER TABLE "relay_cloud_workspaces" ADD COLUMN "provider_endpoint_http_base_url" text;--> statement-breakpoint
ALTER TABLE "relay_cloud_workspaces" ADD COLUMN "provider_endpoint_ws_base_url" text;--> statement-breakpoint
ALTER TABLE "relay_cloud_workspaces" ADD COLUMN "enrollment_token_hash" text;--> statement-breakpoint
ALTER TABLE "relay_cloud_workspaces" ADD COLUMN "enrollment_expires_at" bigint;--> statement-breakpoint
ALTER TABLE "relay_cloud_workspaces" ADD COLUMN "enrolled_environment_public_key" text;