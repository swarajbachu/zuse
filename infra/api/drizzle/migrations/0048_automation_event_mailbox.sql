CREATE TABLE api_automation_registrations (
 workspace_id text NOT NULL REFERENCES api_cloud_workspaces(workspace_id) ON DELETE CASCADE,
 account_id text NOT NULL,
 automation_id text NOT NULL,
 revision integer NOT NULL,
 enabled boolean NOT NULL,
 sealed text NOT NULL,
 webhook_token_sealed text NOT NULL,
 next_run_at bigint,
 PRIMARY KEY(workspace_id,automation_id)
);
--> statement-breakpoint
CREATE INDEX api_automation_registrations_account_idx ON api_automation_registrations(account_id) WHERE enabled=true;
--> statement-breakpoint
CREATE TABLE api_automation_events (
 id text PRIMARY KEY,
 workspace_id text NOT NULL,
 automation_id text NOT NULL,
 revision integer NOT NULL,
 event_id text NOT NULL,
 source text NOT NULL,
 sealed text NOT NULL,
 created_at bigint NOT NULL,
 expires_at bigint NOT NULL,
 acknowledged_at bigint,
 completed_at bigint,
 rejected_reason text,
 FOREIGN KEY(workspace_id,automation_id) REFERENCES api_automation_registrations(workspace_id,automation_id) ON DELETE CASCADE,
 CONSTRAINT api_automation_events_delivery_idx UNIQUE(workspace_id,automation_id,source,event_id)
);
--> statement-breakpoint
CREATE INDEX api_automation_events_pending_idx ON api_automation_events(workspace_id,created_at) WHERE acknowledged_at IS NULL;

--> statement-breakpoint
CREATE INDEX api_automation_registrations_schedule_idx ON api_automation_registrations(next_run_at) WHERE enabled=true;

--> statement-breakpoint
CREATE INDEX api_automation_events_expiry_idx ON api_automation_events(expires_at);

--> statement-breakpoint
CREATE TABLE api_automation_notifications (
 workspace_id text NOT NULL,
 automation_id text NOT NULL,
 run_id text NOT NULL,
 destination text NOT NULL,
 delivered_at bigint NOT NULL,
 PRIMARY KEY(workspace_id,automation_id,run_id,destination),
 FOREIGN KEY(workspace_id,automation_id) REFERENCES api_automation_registrations(workspace_id,automation_id) ON DELETE CASCADE
);

--> statement-breakpoint
CREATE INDEX api_automation_notifications_expiry_idx ON api_automation_notifications(delivered_at);
