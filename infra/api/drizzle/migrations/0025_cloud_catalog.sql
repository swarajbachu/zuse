-- Per-account counter locks serialize publication with the mutation transaction.
-- A compact latest-change index retains deletion tombstones without storing tokens/messages.
CREATE TABLE api_cloud_catalog_heads (account_id text PRIMARY KEY, revision bigint NOT NULL DEFAULT 0);
--> statement-breakpoint
CREATE TABLE api_cloud_catalog_changes (
 account_id text NOT NULL, workspace_id text NOT NULL, revision bigint NOT NULL,
 PRIMARY KEY (account_id, workspace_id)
);
--> statement-breakpoint
CREATE INDEX api_cloud_catalog_changes_cursor_idx ON api_cloud_catalog_changes (account_id, revision);
--> statement-breakpoint
CREATE FUNCTION api_publish_cloud_catalog(a text, w text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r bigint;
BEGIN
 INSERT INTO api_cloud_catalog_heads (account_id, revision) VALUES (a, 1)
 ON CONFLICT (account_id) DO UPDATE SET revision = api_cloud_catalog_heads.revision + 1
 RETURNING revision INTO r;
 INSERT INTO api_cloud_catalog_changes VALUES (a, w, r)
 ON CONFLICT (account_id, workspace_id) DO UPDATE SET revision = EXCLUDED.revision;
END $$;
--> statement-breakpoint
CREATE FUNCTION api_cloud_catalog_workspace_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN PERFORM api_publish_cloud_catalog(OLD.account_id, OLD.workspace_id); RETURN OLD; END IF;
 IF TG_OP = 'UPDATE' AND
  (to_jsonb(NEW) - ARRAY['lease_owner','lease_expires_at','next_action_at']) IS NOT DISTINCT FROM
  (to_jsonb(OLD) - ARRAY['lease_owner','lease_expires_at','next_action_at']) THEN RETURN NEW; END IF;
 PERFORM api_publish_cloud_catalog(NEW.account_id, NEW.workspace_id); RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER api_cloud_catalog_workspace AFTER INSERT OR UPDATE OR DELETE ON api_cloud_workspaces
FOR EACH ROW EXECUTE FUNCTION api_cloud_catalog_workspace_changed();
--> statement-breakpoint
CREATE FUNCTION api_cloud_catalog_summary_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w record;
BEGIN
 SELECT account_id, workspace_id INTO w FROM api_cloud_workspaces WHERE workspace_id = COALESCE(NEW.workspace_id, OLD.workspace_id);
 IF FOUND THEN PERFORM api_publish_cloud_catalog(w.account_id, w.workspace_id); END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER api_cloud_catalog_summary AFTER INSERT OR UPDATE OR DELETE ON api_cloud_workspace_runtime_summaries
FOR EACH ROW EXECUTE FUNCTION api_cloud_catalog_summary_changed();
--> statement-breakpoint
CREATE FUNCTION api_cloud_catalog_project_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w record;
BEGIN
 FOR w IN SELECT account_id, workspace_id FROM api_cloud_workspaces WHERE project_id = NEW.project_id ORDER BY account_id, workspace_id LOOP
  PERFORM api_publish_cloud_catalog(w.account_id, w.workspace_id);
 END LOOP;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER api_cloud_catalog_project AFTER UPDATE ON api_cloud_projects
FOR EACH ROW EXECUTE FUNCTION api_cloud_catalog_project_changed();
