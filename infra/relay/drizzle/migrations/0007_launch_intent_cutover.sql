CREATE TABLE "relay_cloud_workspace_launch_intents" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"session_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"command_id" text NOT NULL,
	"ciphertext" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "relay_cloud_workspace_launch_intents_workspace_id_relay_cloud_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."relay_cloud_workspaces"("workspace_id") ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX "relay_cloud_workspace_launch_intents_command_idx" ON "relay_cloud_workspace_launch_intents" USING btree ("command_id");--> statement-breakpoint
CREATE INDEX "relay_cloud_workspace_launch_intents_expiry_idx" ON "relay_cloud_workspace_launch_intents" USING btree ("expires_at");--> statement-breakpoint
DROP TABLE "relay_cloud_workspace_events";--> statement-breakpoint
DROP TABLE "relay_cloud_workspace_commands";--> statement-breakpoint
DROP TABLE "relay_cloud_workspace_connection_grants";--> statement-breakpoint
ALTER TABLE "relay_cloud_workspaces" DROP COLUMN "chat_metadata_ciphertext";
