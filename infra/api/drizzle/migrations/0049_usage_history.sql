CREATE TABLE "api_usage_history_keys" (
	"account_id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"backup_enabled" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_usage_history" (
	"id" bigserial NOT NULL,
	"account_id" text NOT NULL,
	"hour" text NOT NULL,
	"source_id" text NOT NULL,
	"model" text NOT NULL,
	"session" text NOT NULL,
	"project" text NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_read_tokens" bigint NOT NULL,
	"cache_creation_tokens" bigint NOT NULL,
	"reasoning_tokens" bigint NOT NULL,
	"cost_usd" double precision,
	"record_count" bigint NOT NULL,
	"first_at" bigint NOT NULL,
	"last_at" bigint NOT NULL,
	CONSTRAINT "api_usage_history_pk" PRIMARY KEY("account_id","hour","source_id","model","session","project"),
	CONSTRAINT "api_usage_history_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE INDEX "api_usage_history_account_id_idx" ON "api_usage_history" USING btree ("account_id","id");
