CREATE TABLE "sms_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone_e164" text NOT NULL,
	"consent_text" text NOT NULL,
	"page_url" text,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sms_consents_phone_idx" ON "sms_consents" USING btree ("phone_e164");