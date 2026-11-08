CREATE TABLE "log_watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by" uuid,
	"filters" jsonb NOT NULL,
	"checked_through" timestamp with time zone NOT NULL,
	"next_check_at" timestamp with time zone NOT NULL,
	"subscribers_checked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "log_watches" ADD CONSTRAINT "log_watches_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_watches" ADD CONSTRAINT "log_watches_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "log_watches_due_idx" ON "log_watches" USING btree ("next_check_at") WHERE "log_watches"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "log_watches_organization_idx" ON "log_watches" USING btree ("organization_id") WHERE "log_watches"."ended_at" is null;