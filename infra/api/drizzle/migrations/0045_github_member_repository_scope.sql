-- Existing owner-authorized links keep their installation-wide grant.
-- Member-created links store a repository allowlist enforced on GitHub tokens.
ALTER TABLE api_cloud_github_installations ADD COLUMN allowed_repositories jsonb;
--> statement-breakpoint
ALTER TABLE api_cloud_github_installations ADD CONSTRAINT api_cloud_github_allowed_repositories_array
 CHECK (allowed_repositories IS NULL OR (jsonb_typeof(allowed_repositories) = 'array' AND jsonb_array_length(allowed_repositories) BETWEEN 1 AND 500));
