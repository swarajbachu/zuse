ALTER TABLE "relay_cloud_workspaces" ADD COLUMN "archive_requested_at" bigint;
--> statement-breakpoint
ALTER TABLE "relay_cloud_workspaces" ADD COLUMN "archive_delete_at" bigint;
--> statement-breakpoint
ALTER TABLE "relay_cloud_workspaces" ADD COLUMN "deletion_tombstone_expires_at" bigint;
--> statement-breakpoint
ALTER TABLE "relay_cloud_workspaces" ADD COLUMN "wrapped_transcript_key" text;
--> statement-breakpoint
ALTER TABLE "relay_cloud_workspaces" DROP CONSTRAINT "relay_cloud_workspaces_state_check";
--> statement-breakpoint
ALTER TABLE "relay_cloud_workspaces" ADD CONSTRAINT "relay_cloud_workspaces_state_check" CHECK ("state" IN ('queued', 'provisioning', 'setup', 'ready', 'pausing', 'paused', 'resuming', 'archiving', 'archived', 'deleting', 'deleted', 'failed'));
--> statement-breakpoint
ALTER TABLE "relay_cloud_workspaces" DROP COLUMN "recovery_bundle_key";
--> statement-breakpoint
ALTER TABLE "relay_cloud_workspaces" DROP COLUMN "warm_retention_deadline";
--> statement-breakpoint
CREATE TABLE "relay_cloud_transcript_checkpoints" (
	"workspace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"runtime_generation" bigint NOT NULL,
	"stream_epoch" text NOT NULL,
	"stream_version" bigint NOT NULL,
	"object_key" text NOT NULL,
	"ciphertext_sha256" text NOT NULL,
	"ciphertext_bytes" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "relay_cloud_transcript_checkpoints_pk" PRIMARY KEY("workspace_id", "session_id"),
	CONSTRAINT "relay_cloud_transcript_checkpoints_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."relay_cloud_workspaces"("workspace_id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "relay_cloud_transcript_checkpoint_created_idx" ON "relay_cloud_transcript_checkpoints" USING btree ("created_at");
--> statement-breakpoint
CREATE TABLE "relay_cloud_workspace_command_receipts" (
	"workspace_id" text NOT NULL,
	"command_id" text NOT NULL,
	"action" text NOT NULL,
	"workspace_revision" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "relay_cloud_workspace_command_receipts_pk" PRIMARY KEY("workspace_id", "command_id"),
	CONSTRAINT "relay_cloud_workspace_command_receipts_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."relay_cloud_workspaces"("workspace_id") ON DELETE cascade
);
