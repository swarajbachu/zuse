CREATE TABLE api_github_identities (account_id text PRIMARY KEY, github_user_id bigint NOT NULL UNIQUE, data jsonb NOT NULL);
CREATE TABLE api_github_join_policies (organization_id text NOT NULL, installation_id bigint NOT NULL, github_org_id bigint NOT NULL, data jsonb NOT NULL, PRIMARY KEY (organization_id, installation_id));
CREATE TABLE api_github_enrollments (organization_id text NOT NULL, account_id text NOT NULL, installation_id bigint NOT NULL, data jsonb NOT NULL, PRIMARY KEY (organization_id, account_id));
CREATE INDEX api_github_join_policies_org ON api_github_join_policies (github_org_id);
CREATE INDEX api_github_enrollments_installation ON api_github_enrollments (installation_id);
CREATE INDEX api_github_join_policies_installation ON api_github_join_policies (installation_id);
