CREATE TABLE "slack_connect_channels" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"channel_id" text,
	"channel_name" text,
	"workspace_channel_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_connect_channels_status_check" CHECK ("slack_connect_channels"."status" IN ('pending', 'accepted', 'joined', 'invited', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "slack_connect_channels" ADD CONSTRAINT "slack_connect_channels_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;