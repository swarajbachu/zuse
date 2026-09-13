CREATE TABLE api_slack_installations (
  team_id text PRIMARY KEY,
  owner_id text NOT NULL,
  generation text NOT NULL,
  account_id text,
  revision integer NOT NULL DEFAULT 0,
  sealed text NOT NULL,
  UNIQUE (team_id, generation)
);
--> statement-breakpoint
CREATE INDEX api_slack_installations_account_idx ON api_slack_installations(account_id);
--> statement-breakpoint
CREATE TABLE api_slack_sessions (
  token_hash text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('oauth', 'login', 'settings', 'workos')),
  team_id text NOT NULL,
  owner_id text NOT NULL,
  generation text NOT NULL,
  expires_at bigint NOT NULL,
  payload text NOT NULL
);
--> statement-breakpoint
CREATE INDEX api_slack_sessions_expiry_idx ON api_slack_sessions(expires_at);
--> statement-breakpoint
CREATE TABLE api_slack_state (
  team_id text NOT NULL,
  generation text NOT NULL,
  key text NOT NULL,
  value text NOT NULL,
  expires_at bigint NOT NULL,
  PRIMARY KEY (team_id, generation, key),
  FOREIGN KEY (team_id, generation) REFERENCES api_slack_installations(team_id, generation) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX api_slack_state_expiry_idx ON api_slack_state(expires_at);
