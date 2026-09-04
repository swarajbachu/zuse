CREATE TABLE "api_cloud_auth_authorities" (
	"account_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_sandbox_id" text,
	"storage_incarnation_id" text NOT NULL,
	"auth_epoch" bigint DEFAULT 1 NOT NULL,
	"toolchain_version" text NOT NULL,
	"state" text NOT NULL,
	"provisioning_lease_owner" text,
	"provisioning_lease_expires_at" bigint,
	"revision" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "api_cloud_auth_authorities_state_check" CHECK ("api_cloud_auth_authorities"."state" IN ('provisioning', 'ready', 'error'))
);
--> statement-breakpoint
CREATE INDEX "api_cloud_auth_authorities_state_idx" ON "api_cloud_auth_authorities" USING btree ("state", "provisioning_lease_expires_at");
