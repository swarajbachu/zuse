CREATE TABLE "relay_agent_activity" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"account_id" text NOT NULL,
	"session_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"occurred_at" bigint NOT NULL,
	CONSTRAINT "relay_agent_activity_kind_check" CHECK ("relay_agent_activity"."kind" IN ('approval-needed', 'question-needed', 'completed', 'error', 'running'))
);
--> statement-breakpoint
CREATE TABLE "relay_devices" (
	"device_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"platform" text NOT NULL,
	"push_token" text,
	"dpop_jwk" jsonb,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "relay_devices_platform_check" CHECK ("relay_devices"."platform" IN ('ios', 'android', 'web'))
);
--> statement-breakpoint
CREATE TABLE "relay_dpop_proofs" (
	"thumbprint" text NOT NULL,
	"jti" text NOT NULL,
	"issued_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	CONSTRAINT "relay_dpop_proofs_thumbprint_jti_pk" PRIMARY KEY("thumbprint","jti")
);
--> statement-breakpoint
CREATE TABLE "relay_environment_credentials" (
	"credential_id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"account_id" text NOT NULL,
	"credential_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	"revoked_at" bigint
);
--> statement-breakpoint
CREATE TABLE "relay_environments" (
	"environment_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"org_id" text,
	"provider_kind" text NOT NULL,
	"label" text,
	"environment_public_key" text NOT NULL,
	"http_base_url" text NOT NULL,
	"ws_base_url" text NOT NULL,
	"tunnel_hostname" text,
	"linked_at" bigint NOT NULL,
	"last_seen_at" bigint,
	CONSTRAINT "relay_environments_provider_kind_check" CHECK ("relay_environments"."provider_kind" IN ('desktop', 'ssh', 'cloud'))
);
--> statement-breakpoint
CREATE TABLE "relay_link_challenges" (
	"challenge_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"challenge" text NOT NULL,
	"relay_issuer" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"consumed_at" bigint
);
--> statement-breakpoint
ALTER TABLE "relay_environment_credentials" ADD CONSTRAINT "relay_environment_credentials_environment_id_relay_environments_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."relay_environments"("environment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "relay_agent_activity_env_idx" ON "relay_agent_activity" USING btree ("environment_id","occurred_at");--> statement-breakpoint
CREATE INDEX "relay_devices_account_idx" ON "relay_devices" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "relay_dpop_proofs_expiry_idx" ON "relay_dpop_proofs" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "relay_environment_credentials_env_idx" ON "relay_environment_credentials" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "relay_environments_account_idx" ON "relay_environments" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "relay_link_challenges_account_idx" ON "relay_link_challenges" USING btree ("account_id");