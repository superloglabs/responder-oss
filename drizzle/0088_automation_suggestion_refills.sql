ALTER TABLE "automation_template_suggestions" ADD COLUMN "removed_template_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_template_suggestions" ADD COLUMN "refill_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_template_suggestions" ADD COLUMN "refills" integer DEFAULT 0 NOT NULL;