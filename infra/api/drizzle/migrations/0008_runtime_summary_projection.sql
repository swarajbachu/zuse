CREATE TABLE "relay_cloud_workspace_runtime_summaries" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"runtime_generation" bigint NOT NULL,
	"summary_revision" bigint NOT NULL,
	"title" text NOT NULL,
	"last_activity_at" bigint NOT NULL,
	"session_head_version" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "relay_cloud_runtime_summaries_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."relay_cloud_workspaces"("workspace_id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX "relay_cloud_runtime_summaries_activity_idx" ON "relay_cloud_workspace_runtime_summaries" USING btree ("last_activity_at");
