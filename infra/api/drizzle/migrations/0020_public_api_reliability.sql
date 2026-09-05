CREATE TABLE "api_cloud_workspace_api_turn_receipts" (
	"workspace_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"outcome" text NOT NULL,
	"settled_at" bigint NOT NULL,
	"received_at" bigint NOT NULL,
	"content_digest" text NOT NULL,
	CONSTRAINT "api_cloud_workspace_api_turn_receipts_pk" PRIMARY KEY("workspace_id","turn_id"),
	CONSTRAINT "api_cloud_workspace_api_turn_receipts_outcome_check" CHECK("outcome" IN ('completed', 'interrupted', 'error'))
);
--> statement-breakpoint
ALTER TABLE "api_cloud_workspace_api_turn_receipts" ADD CONSTRAINT "api_cloud_workspace_api_turn_receipts_workspace_id_api_cloud_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."api_cloud_workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "api_cloud_workspace_api_messages" ADD COLUMN "delivery_attempted_at" bigint;
--> statement-breakpoint
DROP INDEX "api_cloud_workspace_api_messages_turn_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "api_cloud_workspace_api_messages_turn_idx" ON "api_cloud_workspace_api_messages" USING btree ("workspace_id", "turn_id") WHERE "api_cloud_workspace_api_messages"."role" = 'assistant' AND "api_cloud_workspace_api_messages"."turn_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "api_cloud_workspace_api_messages_pending_expiry_idx" ON "api_cloud_workspace_api_messages" USING btree ("expires_at") WHERE "api_cloud_workspace_api_messages"."role" = 'user' AND "api_cloud_workspace_api_messages"."status" IN ('pending', 'delivered') AND "api_cloud_workspace_api_messages"."expires_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "api_cloud_workspace_api_messages_pending_stale_idx" ON "api_cloud_workspace_api_messages" USING btree ("created_at", "workspace_id") WHERE "api_cloud_workspace_api_messages"."role" = 'user' AND "api_cloud_workspace_api_messages"."status" = 'pending';
