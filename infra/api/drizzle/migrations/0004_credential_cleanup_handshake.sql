ALTER TABLE "relay_machines" ADD COLUMN "boot_phase" text;--> statement-breakpoint
ALTER TABLE "relay_machines" ADD COLUMN "credential_cleanup_requested_at" bigint;--> statement-breakpoint
ALTER TABLE "relay_machines" ADD COLUMN "credential_cleanup_deadline" bigint;--> statement-breakpoint
ALTER TABLE "relay_machines" ADD COLUMN "credential_cleanup_completed_at" bigint;--> statement-breakpoint
ALTER TABLE "relay_machines" ADD COLUMN "final_snapshot_skipped" boolean DEFAULT false NOT NULL;