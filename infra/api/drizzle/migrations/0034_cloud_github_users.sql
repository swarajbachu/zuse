CREATE TABLE "api_cloud_github_users" (
 "account_id" text PRIMARY KEY NOT NULL,
 "login" text NOT NULL,
 "name" text NOT NULL,
 "email" text NOT NULL,
 "sealed_credentials" text NOT NULL
);
