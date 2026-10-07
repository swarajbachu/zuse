-- Account-wide snapshot inspection precedes repository discovery.
ALTER TABLE api_cloud_project_builds ALTER COLUMN project_id DROP NOT NULL;
CREATE UNIQUE INDEX api_cloud_imported_builds_idempotency_idx
ON api_cloud_project_builds (account_id, provider, idempotency_key)
WHERE project_id IS NULL;

ALTER TABLE api_cloud_workspace_runtime_summaries ADD COLUMN native_agent_access jsonb NOT NULL DEFAULT '[]'::jsonb;
