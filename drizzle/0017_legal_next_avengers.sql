ALTER TABLE "investigations" ADD COLUMN "slack_message_timestamp" text;
ALTER TABLE "investigations" ADD COLUMN "slack_trace_items" jsonb DEFAULT '[]'::jsonb NOT NULL;
