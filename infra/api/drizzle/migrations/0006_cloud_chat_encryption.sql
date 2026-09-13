ALTER TABLE "relay_cloud_workspace_commands" ALTER COLUMN "payload" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_cloud_workspace_events" ALTER COLUMN "payload_json" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_cloud_workspace_commands" ADD COLUMN "encrypted_payload" text;--> statement-breakpoint
ALTER TABLE "relay_cloud_workspace_events" ADD COLUMN "encrypted_payload" text;--> statement-breakpoint
ALTER TABLE "relay_cloud_workspaces" ADD COLUMN "chat_metadata_ciphertext" text;