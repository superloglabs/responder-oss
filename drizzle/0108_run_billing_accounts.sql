CREATE TABLE "run_billing_accounts" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"feature_id" text NOT NULL,
	"model_provider" text NOT NULL,
	"model" text NOT NULL,
	"model_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_billing_accounts" ADD CONSTRAINT "run_billing_accounts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;