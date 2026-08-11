CREATE TABLE "relay_cloud_credential_connections" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"account_label" text,
	"encrypted_payload" text,
	"encryption_key_version" text,
	"credential_version" bigint DEFAULT 1 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"disconnected_at" bigint,
	CONSTRAINT "relay_cloud_credentials_kind_check" CHECK ("relay_cloud_credential_connections"."kind" IN ('github', 'claude', 'codex')),
	CONSTRAINT "relay_cloud_credentials_state_check" CHECK ("relay_cloud_credential_connections"."state" IN ('connected', 'disconnected', 'error'))
);
--> statement-breakpoint
CREATE TABLE "relay_cloud_project_builds" (
	"build_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_sandbox_id" text,
	"snapshot_id" text,
	"source_commit" text,
	"template_version" text NOT NULL,
	"configuration_digest" text NOT NULL,
	"state" text NOT NULL,
	"last_error_code" text,
	"idempotency_key" text NOT NULL,
	"next_action_at" bigint NOT NULL,
	"lease_owner" text,
	"lease_expires_at" bigint,
	"revision" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "relay_cloud_builds_state_check" CHECK ("relay_cloud_project_builds"."state" IN ('queued', 'building', 'sanitizing', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "relay_cloud_projects" (
	"project_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"repository_identity" text NOT NULL,
	"repository_url" text NOT NULL,
	"display_name" text NOT NULL,
	"default_branch" text NOT NULL,
	"visibility" text NOT NULL,
	"git_connection_kind" text NOT NULL,
	"setup_command" text,
	"cloud_environment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_bindings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"configuration_digest" text NOT NULL,
	"state" text NOT NULL,
	"last_error_code" text,
	"idempotency_key" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "relay_cloud_projects_visibility_check" CHECK ("relay_cloud_projects"."visibility" IN ('public', 'private')),
	CONSTRAINT "relay_cloud_projects_state_check" CHECK ("relay_cloud_projects"."state" IN ('connected', 'preparing', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "relay_cloud_workspace_commands" (
	"command_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text NOT NULL,
	"created_at" bigint NOT NULL,
	"claimed_at" bigint,
	"acknowledged_at" bigint,
	"failed_at" bigint,
	CONSTRAINT "relay_cloud_workspace_commands_state_check" CHECK ("relay_cloud_workspace_commands"."state" IN ('queued', 'claimed', 'acknowledged', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "relay_cloud_workspace_connection_grants" (
	"grant_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"consumed_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_cloud_workspace_events" (
	"workspace_id" text NOT NULL,
	"runtime_sequence" bigint NOT NULL,
	"event_id" text NOT NULL,
	"stream_id" text NOT NULL,
	"stream_version" bigint NOT NULL,
	"type" text NOT NULL,
	"payload_json" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "relay_cloud_workspace_events_workspace_id_runtime_sequence_pk" PRIMARY KEY("workspace_id","runtime_sequence")
);
--> statement-breakpoint
CREATE TABLE "relay_cloud_workspace_usage" (
	"event_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"quantity" bigint NOT NULL,
	"provider_event_id" text,
	"occurred_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "relay_cloud_usage_kind_check" CHECK ("relay_cloud_workspace_usage"."kind" IN ('runtime-seconds', 'pause', 'resume', 'snapshot-bytes', 'storage-byte-seconds', 'archive', 'restore', 'delete'))
);
--> statement-breakpoint
CREATE TABLE "relay_cloud_workspaces" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"project_id" text NOT NULL,
	"build_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_sandbox_id" text,
	"runtime_boot_token_hash" text,
	"runtime_boot_token_expires_at" bigint,
	"runtime_credential_hash" text,
	"runtime_state" text DEFAULT 'offline' NOT NULL,
	"chat_id" text NOT NULL,
	"initial_session_id" text NOT NULL,
	"branch" text NOT NULL,
	"base_ref" text NOT NULL,
	"state" text NOT NULL,
	"desired_state" text NOT NULL,
	"status_code" text NOT NULL,
	"credential_epoch" bigint DEFAULT 0 NOT NULL,
	"recovery_bundle_key" text,
	"warm_retention_deadline" bigint,
	"idempotency_key" text NOT NULL,
	"request_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_action_at" bigint NOT NULL,
	"lease_owner" text,
	"lease_expires_at" bigint,
	"revision" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_activity_at" bigint NOT NULL,
	"running_since" bigint,
	"deleted_at" bigint,
	CONSTRAINT "relay_cloud_workspaces_state_check" CHECK ("relay_cloud_workspaces"."state" IN ('queued', 'provisioning', 'setup', 'ready', 'pausing', 'paused', 'resuming', 'archiving', 'archived', 'recovering', 'deleting', 'deleted', 'failed')),
	CONSTRAINT "relay_cloud_workspaces_desired_state_check" CHECK ("relay_cloud_workspaces"."desired_state" IN ('ready', 'paused', 'archived', 'deleted')),
	CONSTRAINT "relay_cloud_workspaces_runtime_state_check" CHECK ("relay_cloud_workspaces"."runtime_state" IN ('offline', 'connecting', 'online'))
);
--> statement-breakpoint
ALTER TABLE "relay_entitlements" DROP CONSTRAINT "relay_entitlements_kind_check";--> statement-breakpoint
ALTER TABLE "relay_cloud_project_builds" ADD CONSTRAINT "relay_cloud_project_builds_project_id_relay_cloud_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."relay_cloud_projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_cloud_workspace_commands" ADD CONSTRAINT "relay_cloud_workspace_commands_workspace_id_relay_cloud_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."relay_cloud_workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_cloud_workspace_connection_grants" ADD CONSTRAINT "relay_cloud_workspace_connection_grants_workspace_id_relay_cloud_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."relay_cloud_workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_cloud_workspace_events" ADD CONSTRAINT "relay_cloud_workspace_events_workspace_id_relay_cloud_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."relay_cloud_workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_cloud_workspace_usage" ADD CONSTRAINT "relay_cloud_workspace_usage_workspace_id_relay_cloud_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."relay_cloud_workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_cloud_workspaces" ADD CONSTRAINT "relay_cloud_workspaces_project_id_relay_cloud_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."relay_cloud_projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_cloud_workspaces" ADD CONSTRAINT "relay_cloud_workspaces_build_id_relay_cloud_project_builds_build_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."relay_cloud_project_builds"("build_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "relay_cloud_credentials_account_kind_idx" ON "relay_cloud_credential_connections" USING btree ("account_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "relay_cloud_builds_project_provider_idempotency_idx" ON "relay_cloud_project_builds" USING btree ("project_id","provider","idempotency_key");--> statement-breakpoint
CREATE INDEX "relay_cloud_builds_active_idx" ON "relay_cloud_project_builds" USING btree ("project_id","provider","state","updated_at");--> statement-breakpoint
CREATE INDEX "relay_cloud_builds_reconcile_idx" ON "relay_cloud_project_builds" USING btree ("state","next_action_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "relay_cloud_projects_account_repo_idx" ON "relay_cloud_projects" USING btree ("account_id","repository_identity");--> statement-breakpoint
CREATE UNIQUE INDEX "relay_cloud_projects_account_idempotency_idx" ON "relay_cloud_projects" USING btree ("account_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "relay_cloud_projects_account_idx" ON "relay_cloud_projects" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relay_cloud_workspace_commands_sequence_idx" ON "relay_cloud_workspace_commands" USING btree ("workspace_id","sequence");--> statement-breakpoint
CREATE INDEX "relay_cloud_workspace_grants_workspace_idx" ON "relay_cloud_workspace_connection_grants" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relay_cloud_workspace_events_id_idx" ON "relay_cloud_workspace_events" USING btree ("workspace_id","event_id");--> statement-breakpoint
CREATE INDEX "relay_cloud_workspace_events_stream_idx" ON "relay_cloud_workspace_events" USING btree ("workspace_id","stream_id","stream_version");--> statement-breakpoint
CREATE UNIQUE INDEX "relay_cloud_usage_provider_event_idx" ON "relay_cloud_workspace_usage" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "relay_cloud_usage_workspace_idx" ON "relay_cloud_workspace_usage" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "relay_cloud_workspaces_account_idempotency_idx" ON "relay_cloud_workspaces" USING btree ("account_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "relay_cloud_workspaces_provider_sandbox_idx" ON "relay_cloud_workspaces" USING btree ("provider","provider_sandbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relay_cloud_workspaces_chat_idx" ON "relay_cloud_workspaces" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "relay_cloud_workspaces_project_idx" ON "relay_cloud_workspaces" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE INDEX "relay_cloud_workspaces_branch_lease_idx" ON "relay_cloud_workspaces" USING btree ("project_id","branch","state");--> statement-breakpoint
CREATE UNIQUE INDEX "relay_cloud_workspaces_active_branch_idx" ON "relay_cloud_workspaces" USING btree ("project_id","branch") WHERE "relay_cloud_workspaces"."state" <> 'deleted';--> statement-breakpoint
CREATE INDEX "relay_cloud_workspaces_reconcile_idx" ON "relay_cloud_workspaces" USING btree ("desired_state","next_action_at","lease_expires_at");--> statement-breakpoint
ALTER TABLE "relay_entitlements" ADD CONSTRAINT "relay_entitlements_kind_check" CHECK ("relay_entitlements"."kind" IN ('persistent-machine', 'cloud-workspace', 'usage-credits'));
