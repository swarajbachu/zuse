CREATE TABLE api_slack_members (
  team_id text NOT NULL,
  generation text NOT NULL,
  user_id text NOT NULL,
  account_id text,
  revision integer NOT NULL DEFAULT 0,
  sealed text NOT NULL,
  PRIMARY KEY (team_id, generation, user_id),
  FOREIGN KEY (team_id, generation) REFERENCES api_slack_installations(team_id, generation) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX api_slack_members_account_idx ON api_slack_members(account_id);
