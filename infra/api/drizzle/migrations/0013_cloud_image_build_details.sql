ALTER TABLE "relay_cloud_project_builds" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "relay_cloud_project_builds" ADD COLUMN "log_text" text;
