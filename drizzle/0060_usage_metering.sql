CREATE TABLE "agent_model_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workload" text NOT NULL,
	"workload_id" uuid NOT NULL,
	"billable" boolean NOT NULL,
	"model" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"request_usage" jsonb,
	"charge_micros" bigint,
	"billed_at" timestamp with time zone,
	"billing_attempted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_model_usage_workload_check" CHECK ("agent_model_usage"."workload" in ('investigation', 'pull_request_review')),
	CONSTRAINT "agent_model_usage_tokens_check" CHECK ("agent_model_usage"."requests" >= 0 and "agent_model_usage"."input_tokens" >= 0 and "agent_model_usage"."cached_input_tokens" >= 0 and "agent_model_usage"."output_tokens" >= 0),
	CONSTRAINT "agent_model_usage_charge_check" CHECK ("agent_model_usage"."charge_micros" is null or "agent_model_usage"."charge_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sandbox_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workload" text NOT NULL,
	"workload_id" uuid NOT NULL,
	"billable" boolean NOT NULL,
	"cpu" integer NOT NULL,
	"memory_gib" integer NOT NULL,
	"disk_gib" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"charge_micros" bigint,
	"billed_at" timestamp with time zone,
	"billing_attempted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_usage_workload_check" CHECK ("sandbox_usage"."workload" in ('automation', 'investigation', 'pull_request_review', 'remediation')),
	CONSTRAINT "sandbox_usage_resources_check" CHECK ("sandbox_usage"."cpu" > 0 and "sandbox_usage"."memory_gib" > 0 and "sandbox_usage"."disk_gib" > 0),
	CONSTRAINT "sandbox_usage_charge_check" CHECK ("sandbox_usage"."charge_micros" is null or "sandbox_usage"."charge_micros" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_model_usage" ADD CONSTRAINT "agent_model_usage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_usage" ADD CONSTRAINT "sandbox_usage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_model_usage_workload_idx" ON "agent_model_usage" USING btree ("workload","workload_id");--> statement-breakpoint
CREATE INDEX "agent_model_usage_organization_created_idx" ON "agent_model_usage" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_model_usage_unbilled_idx" ON "agent_model_usage" USING btree ("created_at") WHERE "agent_model_usage"."billed_at" is null;--> statement-breakpoint
CREATE INDEX "sandbox_usage_workload_idx" ON "sandbox_usage" USING btree ("workload","workload_id");--> statement-breakpoint
CREATE INDEX "sandbox_usage_organization_started_idx" ON "sandbox_usage" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "sandbox_usage_open_idx" ON "sandbox_usage" USING btree ("heartbeat_at") WHERE "sandbox_usage"."stopped_at" is null;--> statement-breakpoint
CREATE INDEX "sandbox_usage_unbilled_idx" ON "sandbox_usage" USING btree ("stopped_at") WHERE "sandbox_usage"."billed_at" is null;