CREATE TABLE "api_usage_profiles" (
 "account_id" text PRIMARY KEY NOT NULL,
 "handle" text NOT NULL,
 "published" boolean DEFAULT false NOT NULL,
 "payload" jsonb NOT NULL,
 CONSTRAINT "api_usage_profiles_handle_unique" UNIQUE("handle")
);
