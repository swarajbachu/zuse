CREATE TABLE "relay_cloud_github_installations" (
	"account_id" text NOT NULL,
	"installation_id" bigint NOT NULL,
	"github_account_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"avatar_url" text,
	"repository_selection" text NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "relay_cloud_github_installations_pk" PRIMARY KEY("account_id", "installation_id"),
	CONSTRAINT "relay_cloud_github_account_type_check" CHECK ("account_type" IN ('User', 'Organization')),
	CONSTRAINT "relay_cloud_github_repository_selection_check" CHECK ("repository_selection" IN ('all', 'selected'))
);
--> statement-breakpoint
CREATE INDEX "relay_cloud_github_installations_account_idx" ON "relay_cloud_github_installations" USING btree ("account_id");
