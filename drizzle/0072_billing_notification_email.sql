DROP INDEX "billing_notification_delivery_target_idx";--> statement-breakpoint
ALTER TABLE "billing_notification_deliveries" ALTER COLUMN "integration_account_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_model_usage_billed_idx" ON "agent_model_usage" USING btree ("billed_at");--> statement-breakpoint
CREATE INDEX "automation_model_usage_billed_idx" ON "automation_model_usage" USING btree ("billed_at");--> statement-breakpoint
CREATE INDEX "billing_notification_delivery_retry_idx" ON "billing_notification_deliveries" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "sandbox_usage_billed_idx" ON "sandbox_usage" USING btree ("billed_at");--> statement-breakpoint
ALTER TABLE "billing_notification_deliveries" ADD CONSTRAINT "billing_notification_delivery_target_key" UNIQUE NULLS NOT DISTINCT("organization_id","period_key","integration_account_id","kind","destination");