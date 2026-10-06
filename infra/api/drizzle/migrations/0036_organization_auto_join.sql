CREATE TABLE api_github_org_members (installation_id bigint NOT NULL, github_user_id bigint NOT NULL, PRIMARY KEY (installation_id, github_user_id));
CREATE INDEX api_github_org_members_user ON api_github_org_members (github_user_id);
CREATE TABLE api_organization_domains (domain text PRIMARY KEY, organization_id text NOT NULL, data jsonb NOT NULL);
CREATE INDEX api_organization_domains_org ON api_organization_domains (organization_id);
CREATE TABLE api_organization_domain_enrollments (organization_id text NOT NULL, account_id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY (organization_id, account_id));
