CREATE TABLE "automation_template_suggestions" (
	"organization_id" uuid NOT NULL,
	"generated_on" text NOT NULL,
	"status" text DEFAULT 'generating' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"templates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_template_suggestions_organization_id_generated_on_pk" PRIMARY KEY("organization_id","generated_on")
);
--> statement-breakpoint
ALTER TABLE "automation_template_suggestions" ADD CONSTRAINT "automation_template_suggestions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;