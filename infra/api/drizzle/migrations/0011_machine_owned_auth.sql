DROP TABLE IF EXISTS "relay_cloud_credential_connections";
--> statement-breakpoint
ALTER TABLE "relay_cloud_workspaces" DROP COLUMN IF EXISTS "credential_epoch";
