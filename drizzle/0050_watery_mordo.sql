CREATE TABLE "model_subscription_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"encrypted_state" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"next_poll_at" timestamp with time zone NOT NULL,
	"credential_id" uuid
);
--> statement-breakpoint
ALTER TABLE "organization_model_credentials" ADD COLUMN "auth_type" text DEFAULT 'api_key' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_subscription_connections" ADD CONSTRAINT "model_subscription_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_subscription_connections" ADD CONSTRAINT "model_subscription_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_subscription_connections_owner_idx" ON "model_subscription_connections" USING btree ("organization_id","user_id");