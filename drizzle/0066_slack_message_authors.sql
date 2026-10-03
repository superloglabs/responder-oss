CREATE TABLE "slack_message_authors" (
	"integration_account_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"author_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_message_authors_integration_account_id_channel_id_author_id_pk" PRIMARY KEY("integration_account_id","channel_id","author_id")
);
--> statement-breakpoint
ALTER TABLE "slack_message_authors" ADD CONSTRAINT "slack_message_authors_integration_account_id_integration_accounts_id_fk" FOREIGN KEY ("integration_account_id") REFERENCES "public"."integration_accounts"("id") ON DELETE cascade ON UPDATE no action;