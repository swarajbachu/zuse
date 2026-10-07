-- Review is opt-in. These records never grant execution or subscription permission.
CREATE TABLE api_review_github_identities (
 actor_id text PRIMARY KEY, github_user_id bigint NOT NULL UNIQUE, verified_at_ms bigint NOT NULL
);
CREATE TABLE api_review_enrollments (
 id text PRIMARY KEY, repository_id bigint NOT NULL, repository_full_name text NOT NULL,
 installation_id bigint NOT NULL, kind text NOT NULL CHECK (kind IN ('personal','shared')),
 github_user_id bigint, owner_id text NOT NULL, enabled_by text NOT NULL,
 model_connection_id text NOT NULL, settings jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1, created_at_ms bigint NOT NULL, updated_at_ms bigint NOT NULL,
 CHECK ((kind='personal' AND github_user_id IS NOT NULL) OR (kind='shared' AND github_user_id IS NULL))
);
CREATE UNIQUE INDEX api_review_personal_enrollment ON api_review_enrollments(repository_id,github_user_id) WHERE enabled AND kind='personal';
CREATE UNIQUE INDEX api_review_shared_enrollment ON api_review_enrollments(repository_id) WHERE enabled AND kind='shared';
CREATE INDEX api_review_enrollment_owner ON api_review_enrollments(owner_id,id);
CREATE TABLE api_review_authorizations (
 id text PRIMARY KEY, actor_id text NOT NULL, owner_id text NOT NULL, repository_full_name text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('personal','shared')), model_connection_id text NOT NULL,
 expires_at_ms bigint NOT NULL, consumed_at_ms bigint, request jsonb NOT NULL
);
CREATE TABLE api_review_inbox (
 delivery_id text PRIMARY KEY, repository_id bigint NOT NULL, event text NOT NULL,
 payload jsonb NOT NULL, received_at_ms bigint NOT NULL, available_at_ms bigint NOT NULL,
 lease_token text, lease_expires_at_ms bigint, processed_at_ms bigint, error_code text
);
CREATE INDEX api_review_inbox_due ON api_review_inbox(available_at_ms) WHERE processed_at_ms IS NULL;
CREATE TABLE api_review_runs (
 id text PRIMARY KEY, comparison_key text NOT NULL UNIQUE, repository_id bigint NOT NULL,
 pull_number integer NOT NULL, owner_id text NOT NULL, enrollment_id text NOT NULL REFERENCES api_review_enrollments(id),
 enrollment_version integer NOT NULL, model_connection_id text NOT NULL,
 snapshot jsonb NOT NULL, state text NOT NULL CHECK (state IN ('queued','provisioning','blocked','reviewing','publishing','completed','partial','failed','cancelled','superseded')),
 blocked_reason text, created_at_ms bigint NOT NULL, updated_at_ms bigint NOT NULL,
 lease_token text, lease_expires_at_ms bigint
);
CREATE INDEX api_review_runs_owner ON api_review_runs(owner_id,created_at_ms,id);
CREATE INDEX api_review_runs_pr ON api_review_runs(repository_id,pull_number);
CREATE TABLE api_review_attempts (
 id text PRIMARY KEY, run_id text NOT NULL REFERENCES api_review_runs(id), ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 2),
 owner_id text NOT NULL, provider text NOT NULL, provider_sandbox_id text,
 allocated_at_ms bigint, stopped_at_ms bigint, maximum_lifetime_ms bigint NOT NULL CHECK (maximum_lifetime_ms BETWEEN 1 AND 600000),
 lease_token text NOT NULL, created_at_ms bigint NOT NULL,
 UNIQUE(run_id,ordinal)
);
CREATE TABLE api_review_publications (
 id text PRIMARY KEY, run_id text NOT NULL REFERENCES api_review_runs(id), owner_id text NOT NULL,
 marker text NOT NULL UNIQUE, payload jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','reconcile','delivered','cancelled')),
 github_id text, retry_count integer NOT NULL DEFAULT 0, lease_token text, lease_expires_at_ms bigint,
 available_at_ms bigint NOT NULL, created_at_ms bigint NOT NULL
);
CREATE INDEX api_review_publications_due ON api_review_publications(available_at_ms) WHERE state IN ('pending','reconcile');

CREATE TABLE api_review_repository_leases (repository_id bigint PRIMARY KEY,token text NOT NULL,expires_at_ms bigint NOT NULL);
CREATE TABLE api_review_native_connections (
 id text PRIMARY KEY,owner_actor_id text NOT NULL,state text NOT NULL,
 data jsonb NOT NULL,lease_token text,lease_expires_at_ms bigint,
 CHECK(state IN ('login-required','authenticating','ready','revoked','lost'))
);
CREATE INDEX api_review_native_connections_actor ON api_review_native_connections(owner_actor_id);
ALTER TABLE api_review_attempts ADD COLUMN lifecycle jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE api_review_attempts ADD COLUMN supervisor_token text;
ALTER TABLE api_review_attempts ADD COLUMN supervisor_expires_at_ms bigint;
CREATE TABLE api_review_fork_approvals(repository_id bigint NOT NULL,pull_number integer NOT NULL,head_sha text NOT NULL,actor_id text NOT NULL,created_at_ms bigint NOT NULL,PRIMARY KEY(repository_id,pull_number,head_sha));
--> statement-breakpoint
CREATE TABLE api_review_native_activities (
 id text PRIMARY KEY,
 connection_id text NOT NULL REFERENCES api_review_native_connections(id),
 owner_id text NOT NULL,
 provider text NOT NULL,
 provider_sandbox_id text,
 started_at_ms bigint NOT NULL,
 stopped_at_ms bigint,
 deadline_ms bigint NOT NULL,
 maximum_cost_micros bigint NOT NULL,
 state text NOT NULL CHECK(state IN ('admitted','running','stopped','unknown'))
);
--> statement-breakpoint
CREATE INDEX api_review_native_activity_open_idx ON api_review_native_activities(state,deadline_ms);
--> statement-breakpoint
ALTER TABLE api_review_native_activities ADD COLUMN kind text NOT NULL DEFAULT 'login' CHECK(kind IN ('login','check'));
ALTER TABLE api_review_native_activities ADD COLUMN run_id text REFERENCES api_review_runs(id);
ALTER TABLE api_review_native_activities ADD COLUMN attempt_id text REFERENCES api_review_attempts(id);
ALTER TABLE api_review_native_activities ADD COLUMN size text;
