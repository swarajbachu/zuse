-- Deploy the API without pool allocation/refill first. Retire unclaimed provider
-- sandboxes and remove their rows before this migration; never discard the IDs
-- while those resources may still be billing. Claimed machines belong to their
-- workspaces and must not be deleted during retirement.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM api_cloud_workspace_pool WHERE state <> 'claimed') THEN
    RAISE EXCEPTION 'Retire unclaimed workspace pool sandboxes before dropping the pool table';
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE api_cloud_workspace_pool;
