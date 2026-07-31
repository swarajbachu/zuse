CREATE TABLE "relay_revoked_dpop_keys" (
	"thumbprint" text PRIMARY KEY NOT NULL,
	"revoked_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relay_devices" DROP CONSTRAINT "relay_devices_platform_check";--> statement-breakpoint
ALTER TABLE "relay_devices" ADD COLUMN "dpop_thumbprint" text;--> statement-breakpoint
UPDATE "relay_devices" SET "dpop_thumbprint" = "device_id" WHERE "dpop_thumbprint" IS NULL;--> statement-breakpoint
ALTER TABLE "relay_devices" ALTER COLUMN "dpop_thumbprint" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_environments" ADD COLUMN "runtime_version" text;--> statement-breakpoint
ALTER TABLE "relay_environments" ADD COLUMN "wire_protocol_version" bigint;--> statement-breakpoint
ALTER TABLE "relay_environments" ADD COLUMN "capabilities" jsonb;--> statement-breakpoint
ALTER TABLE "relay_environments" ADD COLUMN "service_state" text;--> statement-breakpoint
ALTER TABLE "relay_devices" ADD CONSTRAINT "relay_devices_platform_check" CHECK ("relay_devices"."platform" IN ('ios', 'android', 'web', 'desktop'));--> statement-breakpoint
ALTER TABLE "relay_environments" ADD CONSTRAINT "relay_environments_service_state_check" CHECK ("relay_environments"."service_state" IS NULL OR "relay_environments"."service_state" IN ('starting', 'healthy', 'degraded', 'stopped', 'updating'));
