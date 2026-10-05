CREATE TABLE "slack_direct_message_welcomes" (
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_direct_message_welcomes_team_id_user_id_pk" PRIMARY KEY("team_id","user_id")
);
