CREATE TABLE "c15t_auditLog" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"entityType" text NOT NULL,
	"entityId" text NOT NULL,
	"actionType" text NOT NULL,
	"subjectId" text,
	"ipAddress" text,
	"userAgent" text,
	"changes" json,
	"metadata" json,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"tenantId" text
);
--> statement-breakpoint
CREATE TABLE "c15t_consent" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"subjectId" text NOT NULL,
	"domainId" text NOT NULL,
	"policyId" text,
	"purposeIds" json NOT NULL,
	"metadata" json,
	"ipAddress" text,
	"userAgent" text,
	"givenAt" timestamp DEFAULT now() NOT NULL,
	"validUntil" timestamp,
	"jurisdiction" text,
	"jurisdictionModel" text,
	"tcString" text,
	"uiSource" text,
	"consentAction" text,
	"runtimePolicyDecisionId" text,
	"runtimePolicySource" text,
	"tenantId" text
);
--> statement-breakpoint
CREATE TABLE "c15t_consentPolicy" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"type" text NOT NULL,
	"hash" text,
	"effectiveDate" timestamp NOT NULL,
	"isActive" boolean NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"tenantId" text
);
--> statement-breakpoint
CREATE TABLE "c15t_consentPurpose" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"tenantId" text
);
--> statement-breakpoint
CREATE TABLE "c15t_domain" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"tenantId" text
);
--> statement-breakpoint
CREATE TABLE "c15t_runtimePolicyDecision" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"tenantId" text,
	"policyId" text NOT NULL,
	"fingerprint" text NOT NULL,
	"matchedBy" text NOT NULL,
	"countryCode" text,
	"regionCode" text,
	"jurisdiction" text NOT NULL,
	"language" text,
	"model" text NOT NULL,
	"policyI18n" json,
	"uiMode" text,
	"bannerUi" json,
	"dialogUi" json,
	"categories" json,
	"preselectedCategories" json,
	"proofConfig" json,
	"dedupeKey" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "c15t_runtimePolicyDecision_dedupeKey_unique" UNIQUE("dedupeKey")
);
--> statement-breakpoint
CREATE TABLE "c15t_subject" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"externalId" text,
	"identityProvider" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"tenantId" text
);
--> statement-breakpoint
CREATE TABLE "private_c15t_settings" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"version" varchar(255) DEFAULT '2.0.0' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "c15t_auditLog" ADD CONSTRAINT "auditLog_subject_subject_fk" FOREIGN KEY ("subjectId") REFERENCES "public"."c15t_subject"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "c15t_consent" ADD CONSTRAINT "consent_subject_subject_fk" FOREIGN KEY ("subjectId") REFERENCES "public"."c15t_subject"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "c15t_consent" ADD CONSTRAINT "consent_domain_domain_fk" FOREIGN KEY ("domainId") REFERENCES "public"."c15t_domain"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "c15t_consent" ADD CONSTRAINT "consent_consentPolicy_policy_fk" FOREIGN KEY ("policyId") REFERENCES "public"."c15t_consentPolicy"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "c15t_consent" ADD CONSTRAINT "consent_runtimePolicyDecision_runtimePolicyDecision_fk" FOREIGN KEY ("runtimePolicyDecisionId") REFERENCES "public"."c15t_runtimePolicyDecision"("id") ON DELETE restrict ON UPDATE restrict;