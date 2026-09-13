CREATE TABLE IF NOT EXISTS "relay_revoked_dpop_keys" (
	"thumbprint" text PRIMARY KEY NOT NULL,
	"revoked_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relay_devices" ADD COLUMN IF NOT EXISTS "dpop_thumbprint" text;--> statement-breakpoint
UPDATE "relay_devices" SET "dpop_thumbprint" = "device_id" WHERE "dpop_thumbprint" IS NULL;--> statement-breakpoint
ALTER TABLE "relay_devices" ALTER COLUMN "dpop_thumbprint" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_environments" ADD COLUMN IF NOT EXISTS "runtime_version" text;--> statement-breakpoint
ALTER TABLE "relay_environments" ADD COLUMN IF NOT EXISTS "wire_protocol_version" bigint;--> statement-breakpoint
ALTER TABLE "relay_environments" ADD COLUMN IF NOT EXISTS "capabilities" jsonb;--> statement-breakpoint
ALTER TABLE "relay_environments" ADD COLUMN IF NOT EXISTS "service_state" text;--> statement-breakpoint
ALTER TABLE "relay_devices" DROP CONSTRAINT IF EXISTS "relay_devices_platform_check";--> statement-breakpoint
ALTER TABLE "relay_devices" ADD CONSTRAINT "relay_devices_platform_check" CHECK ("relay_devices"."platform" IN ('ios', 'android', 'web', 'desktop'));--> statement-breakpoint
ALTER TABLE "relay_environments" DROP CONSTRAINT IF EXISTS "relay_environments_service_state_check";--> statement-breakpoint
ALTER TABLE "relay_environments" ADD CONSTRAINT "relay_environments_service_state_check" CHECK ("relay_environments"."service_state" IS NULL OR "relay_environments"."service_state" IN ('starting', 'healthy', 'degraded', 'stopped', 'updating'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "relay_billing_events" (
	"event_id" text NOT NULL,
	"provider" text NOT NULL,
	"payload" jsonb,
	"received_at" bigint NOT NULL,
	"processed_at" bigint,
	CONSTRAINT "relay_billing_events_provider_event_id_pk" PRIMARY KEY("provider","event_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "relay_entitlements" (
	"entitlement_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"offer_id" text,
	"provider" text NOT NULL,
	"provider_subscription_id" text,
	"status" text NOT NULL,
	"paid_through" bigint,
	"ended_at" bigint,
	"credit_balance" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "relay_entitlements_kind_check" CHECK ("relay_entitlements"."kind" IN ('persistent-machine', 'usage-credits')),
	CONSTRAINT "relay_entitlements_status_check" CHECK ("relay_entitlements"."status" IN ('pending', 'active', 'grace', 'ended'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "relay_machines" (
	"machine_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"environment_id" text,
	"provider" text NOT NULL,
	"provider_server_id" text,
	"provider_label" text NOT NULL,
	"label" text,
	"state" text NOT NULL,
	"desired_state" text NOT NULL,
	"status_code" text NOT NULL,
	"stable_failure_code" text,
	"last_error" text,
	"entitlement_id" text NOT NULL,
	"enrollment_token_hash" text,
	"enrollment_expires_at" bigint,
	"enrolled_environment_public_key" text,
	"final_snapshot_id" text,
	"final_snapshot_delete_at" bigint,
	"paid_through" bigint,
	"recovery_deadline" bigint,
	"account_deletion_requested_at" bigint,
	"next_action_at" bigint NOT NULL,
	"attempt_count" bigint DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" bigint,
	"revision" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"suspended_at" bigint,
	"destroyed_at" bigint,
	CONSTRAINT "relay_machines_state_check" CHECK ("relay_machines"."state" IN ('creating', 'bootstrapping', 'enrolling', 'ready', 'suspending', 'suspended', 'resuming', 'destroying', 'destroyed', 'failed')),
	CONSTRAINT "relay_machines_desired_state_check" CHECK ("relay_machines"."desired_state" IN ('ready', 'suspended', 'destroyed'))
);
--> statement-breakpoint
ALTER TABLE "relay_machines" ADD COLUMN IF NOT EXISTS "account_deletion_requested_at" bigint;--> statement-breakpoint
ALTER TABLE "relay_machines" ADD COLUMN IF NOT EXISTS "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_machines" ALTER COLUMN "entitlement_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_environments" ADD COLUMN IF NOT EXISTS "private_http_base_url" text;--> statement-breakpoint
ALTER TABLE "relay_environments" ADD COLUMN IF NOT EXISTS "private_ws_base_url" text;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'relay_machines_entitlement_id_relay_entitlements_entitlement_id_fk'
	) THEN
		ALTER TABLE "relay_machines" ADD CONSTRAINT "relay_machines_entitlement_id_relay_entitlements_entitlement_id_fk" FOREIGN KEY ("entitlement_id") REFERENCES "public"."relay_entitlements"("entitlement_id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relay_entitlements_account_idx" ON "relay_entitlements" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relay_entitlements_subscription_idx" ON "relay_entitlements" USING btree ("provider","provider_subscription_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relay_machines_account_idx" ON "relay_machines" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "relay_machines_account_idempotency_idx" ON "relay_machines" USING btree ("account_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "relay_machines_enroll_token_idx" ON "relay_machines" USING btree ("enrollment_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "relay_machines_environment_idx" ON "relay_machines" USING btree ("environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "relay_machines_provider_server_idx" ON "relay_machines" USING btree ("provider","provider_server_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relay_machines_reconcile_idx" ON "relay_machines" USING btree ("desired_state","next_action_at","lease_expires_at");
