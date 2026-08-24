ALTER TABLE "issues" ADD COLUMN "root_cause" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "timeline" jsonb DEFAULT '[]'::jsonb NOT NULL;