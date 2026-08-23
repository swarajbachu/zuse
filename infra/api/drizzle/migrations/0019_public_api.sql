CREATE TABLE "api_api_keys" (
	"key_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint,
	"revoked_at" bigint
);
--> statement-breakpoint
CREATE TABLE "api_api_webhooks" (
	"webhook_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"url" text NOT NULL,
	"sealed_secret" text NOT NULL,
	"description" text,
	"created_at" bigint NOT NULL,
	"disabled_at" bigint
);
--> statement-breakpoint
CREATE TABLE "api_cloud_workspace_api_messages" (
	"message_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"role" text NOT NULL,
	"sealed_content" text NOT NULL,
	"command_id" text,
	"turn_id" text,
	"outcome" text,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"delivered_at" bigint,
	"expires_at" bigint,
	CONSTRAINT "api_cloud_workspace_api_messages_role_check" CHECK ("role" IN ('user', 'assistant')),
	CONSTRAINT "api_cloud_workspace_api_messages_status_check" CHECK ("status" IN ('pending', 'delivered', 'settled', 'failed', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "api_api_webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"account_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"sealed_payload" text NOT NULL,
	"status" text NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint NOT NULL,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "api_api_webhook_deliveries_status_check" CHECK ("status" IN ('pending', 'delivered', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "api_cloud_workspace_api_messages" ADD CONSTRAINT "api_cloud_workspace_api_messages_workspace_id_api_cloud_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."api_cloud_workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "api_api_webhook_deliveries" ADD CONSTRAINT "api_api_webhook_deliveries_webhook_id_api_api_webhooks_webhook_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."api_api_webhooks"("webhook_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "api_api_keys_account_idx" ON "api_api_keys" USING btree ("account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "api_api_keys_secret_hash_idx" ON "api_api_keys" USING btree ("secret_hash");
--> statement-breakpoint
CREATE INDEX "api_api_webhooks_account_idx" ON "api_api_webhooks" USING btree ("account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "api_cloud_workspace_api_messages_seq_idx" ON "api_cloud_workspace_api_messages" USING btree ("workspace_id", "seq");
--> statement-breakpoint
CREATE UNIQUE INDEX "api_cloud_workspace_api_messages_turn_idx" ON "api_cloud_workspace_api_messages" USING btree ("workspace_id", "turn_id") WHERE "api_cloud_workspace_api_messages"."turn_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "api_cloud_workspace_api_messages_pending_idx" ON "api_cloud_workspace_api_messages" USING btree ("workspace_id", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX "api_api_webhook_deliveries_event_idx" ON "api_api_webhook_deliveries" USING btree ("webhook_id", "event_id");
--> statement-breakpoint
CREATE INDEX "api_api_webhook_deliveries_due_idx" ON "api_api_webhook_deliveries" USING btree ("status", "next_attempt_at");
