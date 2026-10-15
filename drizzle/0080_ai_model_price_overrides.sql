CREATE TABLE "ai_model_price_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"input_mtok" double precision NOT NULL,
	"cache_read_mtok" double precision,
	"cache_write_mtok" double precision,
	"output_mtok" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_model_price_overrides_model_unique" UNIQUE("organization_id","provider","model")
);
--> statement-breakpoint
ALTER TABLE "ai_model_price_overrides" ADD CONSTRAINT "ai_model_price_overrides_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;