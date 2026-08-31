CREATE TABLE "legacy_account_redirect" (
	"email_normalized" text PRIMARY KEY NOT NULL,
	"old_user_id" text NOT NULL,
	"redirect_enabled" boolean DEFAULT true NOT NULL,
	"source_snapshot" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "legacy_account_redirect_enabled_idx" ON "legacy_account_redirect" USING btree ("redirect_enabled");