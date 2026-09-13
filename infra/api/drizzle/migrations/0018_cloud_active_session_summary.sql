ALTER TABLE "api_cloud_workspace_runtime_summaries" ADD COLUMN "active_session_id" text;

UPDATE "api_cloud_workspace_runtime_summaries" AS "summary"
SET "active_session_id" = "workspace"."initial_session_id"
FROM "api_cloud_workspaces" AS "workspace"
WHERE "workspace"."workspace_id" = "summary"."workspace_id";
