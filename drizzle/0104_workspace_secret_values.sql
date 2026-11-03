ALTER TABLE "workspace_secrets" ALTER COLUMN "daytona_secret_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_secrets" ALTER COLUMN "daytona_secret_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_secrets" ADD COLUMN "encrypted_value" text;