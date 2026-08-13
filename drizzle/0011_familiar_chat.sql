ALTER TABLE "investigations" ADD COLUMN "replay_report" jsonb;--> statement-breakpoint
ALTER TABLE "investigations" ADD COLUMN "is_replay" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "investigations" ADD COLUMN "replay_of_investigation_id" uuid;--> statement-breakpoint
CREATE INDEX "investigations_replay_source_idx" ON "investigations" USING btree ("replay_of_investigation_id");