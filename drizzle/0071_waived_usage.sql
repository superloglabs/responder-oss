ALTER TABLE "agent_model_usage" ADD COLUMN "waived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_model_usage" ADD COLUMN "credited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_model_usage" ADD COLUMN "credit_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_model_usage" ADD COLUMN "waived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_model_usage" ADD COLUMN "credited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_model_usage" ADD COLUMN "credit_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandbox_usage" ADD COLUMN "billed_balance" text;--> statement-breakpoint
ALTER TABLE "sandbox_usage" ADD COLUMN "waived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandbox_usage" ADD COLUMN "credited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandbox_usage" ADD COLUMN "credit_attempted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agent_model_usage_uncredited_idx" ON "agent_model_usage" USING btree ("waived_at") WHERE "agent_model_usage"."waived_at" is not null and "agent_model_usage"."credited_at" is null;--> statement-breakpoint
CREATE INDEX "automation_model_usage_uncredited_idx" ON "automation_model_usage" USING btree ("waived_at") WHERE "automation_model_usage"."waived_at" is not null and "automation_model_usage"."credited_at" is null;--> statement-breakpoint
CREATE INDEX "sandbox_usage_uncredited_idx" ON "sandbox_usage" USING btree ("waived_at") WHERE "sandbox_usage"."waived_at" is not null and "sandbox_usage"."credited_at" is null;--> statement-breakpoint
ALTER TABLE "sandbox_usage" ADD CONSTRAINT "sandbox_usage_billed_balance_check" CHECK ("sandbox_usage"."billed_balance" is null or "sandbox_usage"."billed_balance" in ('machine_hours', 'usage_credit'));