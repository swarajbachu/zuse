CREATE TABLE "relay_cloud_workspace_pool" (
	"pool_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider" text NOT NULL,
	"image_generation" text NOT NULL,
	"provider_sandbox_id" text NOT NULL,
	"state" text NOT NULL,
	"claimed_workspace_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "relay_cloud_pool_state_check" CHECK ("state" IN ('available', 'claimed', 'deleting'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "relay_cloud_pool_provider_sandbox_idx" ON "relay_cloud_workspace_pool" USING btree ("provider", "provider_sandbox_id");
--> statement-breakpoint
CREATE INDEX "relay_cloud_pool_available_idx" ON "relay_cloud_workspace_pool" USING btree ("account_id", "provider", "image_generation", "state");
