CREATE SCHEMA IF NOT EXISTS "mandate";
--> statement-breakpoint
CREATE TABLE "mandate"."rate_limit_windows" (
	"bucket" text NOT NULL,
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_windows_bucket_key_window_start_pk" PRIMARY KEY("bucket","key","window_start")
);
--> statement-breakpoint
CREATE TABLE "mandate"."rationale_cache" (
	"url" text PRIMARY KEY NOT NULL,
	"body" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limit_windows_start" ON "mandate"."rate_limit_windows" USING btree ("window_start");