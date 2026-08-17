import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  InvestigationReportSubmission,
  IssueEvidence,
  StructuredInvestigationReport,
} from "../investigations/report.js";
import { organization, user } from "./auth-schema.js";

export const integrationProvider = pgEnum("integration_provider", [
  "aws",
  "github",
  "slack",
  "sentry",
  "datadog",
  "clickstack",
  "upstash",
  "vercel",
  "custom_mcp",
  "linear",
]);

export const integrationResourceKind = pgEnum("integration_resource_kind", [
  "slack_channel",
  "sentry_project",
  "datadog_monitor",
  "vercel_project",
]);

export const triggerKind = pgEnum("trigger_kind", [
  "sentry_issue",
  "datadog_monitor",
  "slack_channel",
  "slack_mention",
]);

export const investigationStatus = pgEnum("investigation_status", [
  "pending",
  "investigating",
  "resolved",
  "failed",
]);

export const investigationReplayRequestStatus = pgEnum(
  "investigation_replay_request_status",
  ["pending", "processing", "queued", "completed", "failed"],
);

export const severity = pgEnum("severity", ["SEV-1", "SEV-2", "SEV-3"]);

export const issueRelationship = pgEnum("issue_relationship", [
  "new",
  "recurrence",
]);

export type RuntimeProfileModelOptions = Record<string, unknown>;

export const runtimeProfiles = pgTable(
  "runtime_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    version: serial("version").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    model: text("model").notNull(),
    modelOptions: jsonb("model_options")
      .$type<RuntimeProfileModelOptions>()
      .notNull()
      .default({}),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("runtime_profiles_version_idx").on(table.version)],
);

export const instanceConfiguration = pgTable("instance_configuration", {
  id: text("id").primaryKey(),
  activeRuntimeProfileId: uuid("active_runtime_profile_id").references(
    () => runtimeProfiles.id,
    { onDelete: "restrict" },
  ),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    activeVersionId: uuid("active_version_id"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("agents_organization_idx").on(table.organizationId)],
);

export type AgentTriggerConfig =
  | {
      integrationAccountId: string;
      projectIds: string[];
    }
  | {
      integrationAccountId: string;
      monitorIds: string[];
    }
  | {
      integrationAccountId: string;
      channelId: string;
    }
  | {
      integrationAccountId: string;
      channelIds: string[];
    };

export type AgentReportConfig =
  | {
      mode: "thread";
    }
  | {
      mode: "output_channel" | "both";
      integrationAccountId: string;
      outputChannelId: string;
      severities?: Array<"SEV-1" | "SEV-2" | "SEV-3">;
    };

export type AgentPrMode = "disabled" | "manual" | "always";

export const agentConfigVersions = pgTable(
  "agent_config_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    prompt: text("prompt").notNull(),
    model: text("model").notNull(),
    trigger: triggerKind("trigger").notNull(),
    triggerConfig: jsonb("trigger_config").$type<AgentTriggerConfig>().notNull(),
    reportConfig: jsonb("report_config").$type<AgentReportConfig>().notNull(),
    contextAccountIds: jsonb("context_account_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    contextResourceIds: jsonb("context_resource_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    legacyPrMode: boolean("pr_mode").notNull().default(false),
    prMode: text("pr_mode_policy")
      .$type<AgentPrMode>()
      .notNull()
      .default("disabled"),
    createLinearTickets: boolean("create_linear_tickets").notNull().default(false),
    linearIssueTemplate: text("linear_issue_template")
      .notNull()
      .default("## Responder issue\n[{{issue_id}}]({{issue_url}})\n\n## Description\n{{description}}\n\n## Evidence\n{{evidence}}\n\n## Recommended remediation\n{{remediation}}"),
    createdBy: uuid("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_config_versions_agent_version_idx").on(table.agentId, table.version),
    index("agent_config_versions_agent_idx").on(table.agentId),
  ],
);

export const integrationAccounts = pgTable(
  "integration_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    provider: integrationProvider("provider").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status").notNull().default("connected"),
    encryptedCredentials: text("encrypted_credentials"),
    credentialKeyVersion: integer("credential_key_version"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("integration_accounts_organization_provider_external_idx").on(
      table.organizationId,
      table.provider,
      table.externalAccountId,
    ),
    index("integration_accounts_organization_idx").on(table.organizationId),
  ],
);

export const integrationConnectionStates = pgTable(
  "integration_connection_states",
  {
    stateHash: text("state_hash").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: integrationProvider("provider").notNull(),
    codeVerifier: text("code_verifier"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    returnTo: text("return_to").notNull().default("/settings"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("integration_connection_states_expires_idx").on(table.expiresAt),
    index("integration_connection_states_organization_idx").on(table.organizationId),
    uniqueIndex("integration_connection_states_owner_provider_idx").on(
      table.organizationId,
      table.userId,
      table.provider,
    ),
  ],
);

export const integrationResources = pgTable(
  "integration_resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    integrationAccountId: uuid("integration_account_id")
      .notNull()
      .references(() => integrationAccounts.id, { onDelete: "cascade" }),
    kind: integrationResourceKind("kind").notNull(),
    externalId: text("external_id").notNull(),
    displayName: text("display_name").notNull(),
    available: boolean("available").notNull().default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("integration_resources_account_kind_external_idx").on(
      table.integrationAccountId,
      table.kind,
      table.externalId,
    ),
    index("integration_resources_account_idx").on(table.integrationAccountId),
  ],
);

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    integrationAccountId: uuid("integration_account_id")
      .notNull()
      .references(() => integrationAccounts.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    private: boolean("private").notNull().default(true),
    available: boolean("available").notNull().default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("repositories_installation_external_idx").on(
      table.integrationAccountId,
      table.externalId,
    ),
  ],
);

export const agentVersionRepositories = pgTable(
  "agent_version_repositories",
  {
    agentConfigVersionId: uuid("agent_config_version_id")
      .notNull()
      .references(() => agentConfigVersions.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.agentConfigVersionId, table.repositoryId] }),
  ],
);

export const workspaceSecrets = pgTable(
  "workspace_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    daytonaSecretId: text("daytona_secret_id").notNull(),
    daytonaSecretName: text("daytona_secret_name").notNull(),
    allowedHosts: jsonb("allowed_hosts").$type<string[]>().notNull(),
    createdBy: uuid("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("workspace_secrets_organization_name_idx").on(
      table.organizationId,
      table.name,
    ),
    uniqueIndex("workspace_secrets_daytona_id_idx").on(table.daytonaSecretId),
    uniqueIndex("workspace_secrets_daytona_name_idx").on(
      table.daytonaSecretName,
    ),
  ],
);

export const agentVersionSecrets = pgTable(
  "agent_version_secrets",
  {
    agentConfigVersionId: uuid("agent_config_version_id")
      .notNull()
      .references(() => agentConfigVersions.id, { onDelete: "cascade" }),
    workspaceSecretId: uuid("workspace_secret_id")
      .notNull()
      .references(() => workspaceSecrets.id, { onDelete: "restrict" }),
  },
  (table) => [
    primaryKey({
      columns: [table.agentConfigVersionId, table.workspaceSecretId],
    }),
  ],
);

export interface InvestigationInput {
  provider: "sentry" | "datadog" | "slack";
  externalEventId: string;
  title: string;
  body: string;
  sourceUrl?: string;
  attributes?: Record<string, string | number | boolean | null>;
}

export interface InvestigationFinding {
  summary: string;
  impact: string;
  remediation: string;
  evidence: string[];
  pullRequestUrl?: string;
}

export interface InvestigationTraceEvent {
  type: string;
  data?: unknown;
  meta?: {
    at?: string;
  };
}

export interface InvestigationSlackTraceItem {
  detail?: string;
  id: string;
  output?: string;
  status: "pending" | "in_progress" | "complete" | "error";
  title: string;
}

export const investigations = pgTable(
  "investigations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    agentConfigVersionId: uuid("agent_config_version_id")
      .notNull()
      .references(() => agentConfigVersions.id, { onDelete: "restrict" }),
    runtimeProfileId: uuid("runtime_profile_id").references(
      () => runtimeProfiles.id,
      { onDelete: "restrict" },
    ),
    status: investigationStatus("status").notNull().default("pending"),
    title: text("title").notNull(),
    input: jsonb("input").$type<InvestigationInput>().notNull(),
    finding: jsonb("finding").$type<InvestigationFinding>(),
    structuredReport: jsonb("structured_report").$type<StructuredInvestigationReport>(),
    replayReport: jsonb("replay_report").$type<InvestigationReportSubmission>(),
    reportMarkdown: text("report_markdown"),
    isReplay: boolean("is_replay").notNull().default(false),
    replayOfInvestigationId: uuid("replay_of_investigation_id"),
    eveSessionId: text("eve_session_id"),
    slackMessageTimestamp: text("slack_message_timestamp"),
    slackTraceItems: jsonb("slack_trace_items")
      .$type<InvestigationSlackTraceItem[]>()
      .notNull()
      .default([]),
    failureReason: text("failure_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("investigations_organization_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    index("investigations_agent_created_idx").on(table.agentId, table.createdAt),
    index("investigations_replay_source_idx").on(table.replayOfInvestigationId),
    foreignKey({
      columns: [table.replayOfInvestigationId],
      foreignColumns: [table.id],
      name: "investigations_replay_source_fk",
    }).onDelete("set null"),
  ],
);

export const investigationReplayRequests = pgTable(
  "investigation_replay_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceInvestigationId: uuid("source_investigation_id")
      .notNull()
      .references(() => investigations.id, { onDelete: "cascade" }),
    replayInvestigationId: uuid("replay_investigation_id").notNull(),
    requestedBy: text("requested_by").notNull(),
    status: investigationReplayRequestStatus("status")
      .notNull()
      .default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    processingStartedAt: timestamp("processing_started_at", {
      withTimezone: true,
    }),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("investigation_replay_requests_replay_idx").on(
      table.replayInvestigationId,
    ),
    index("investigation_replay_requests_claim_idx").on(
      table.status,
      table.createdAt,
    ),
    index("investigation_replay_requests_source_idx").on(
      table.sourceInvestigationId,
      table.createdAt,
    ),
  ],
);

export const investigationTraceEvents = pgTable(
  "investigation_trace_events",
  {
    id: serial("id").primaryKey(),
    investigationId: uuid("investigation_id")
      .notNull()
      .references(() => investigations.id, { onDelete: "cascade" }),
    event: jsonb("event").$type<InvestigationTraceEvent>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("investigation_trace_events_investigation_id_idx").on(
      table.investigationId,
      table.id,
    ),
  ],
);

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    severity: severity("severity").notNull(),
    remediation: text("remediation").notNull(),
    evidence: jsonb("evidence").$type<IssueEvidence[]>().notNull().default([]),
    embedding: jsonb("embedding").$type<number[]>(),
    embeddingModel: text("embedding_model"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("issues_organization_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);

export const activeIssuePullRequestIndexPredicate = sql.raw(
  `"status" in ('queued', 'creating', 'created')`,
);

export const issuePullRequests = pgTable(
  "issue_pull_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    investigationId: uuid("investigation_id")
      .notNull()
      .references(() => investigations.id, { onDelete: "cascade" }),
    agentConfigVersionId: uuid("agent_config_version_id")
      .notNull()
      .references(() => agentConfigVersions.id, { onDelete: "restrict" }),
    repositoryFullName: text("repository_full_name"),
    status: text("status")
      .$type<"queued" | "creating" | "created" | "merged" | "failed">()
      .notNull()
      .default("queued"),
    branch: text("branch"),
    pullRequestNumber: integer("pull_request_number"),
    pullRequestUrl: text("pull_request_url"),
    eveSessionId: text("eve_session_id"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("issue_pull_requests_active_issue_idx")
      .on(table.issueId)
      .where(activeIssuePullRequestIndexPredicate),
    index("issue_pull_requests_issue_created_idx").on(
      table.issueId,
      table.createdAt,
    ),
    index("issue_pull_requests_investigation_idx").on(table.investigationId),
  ],
);

export const issueLinearTickets = pgTable(
  "issue_linear_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    investigationId: uuid("investigation_id")
      .notNull()
      .references(() => investigations.id, { onDelete: "cascade" }),
    agentConfigVersionId: uuid("agent_config_version_id")
      .notNull()
      .references(() => agentConfigVersions.id, { onDelete: "restrict" }),
    integrationAccountId: uuid("integration_account_id")
      .notNull()
      .references(() => integrationAccounts.id, { onDelete: "restrict" }),
    status: text("status")
      .$type<"pending" | "creating" | "created" | "failed">()
      .notNull()
      .default("pending"),
    teamId: text("team_id"),
    projectId: text("project_id"),
    linearIssueId: text("linear_issue_id"),
    linearIdentifier: text("linear_identifier"),
    linearIssueUrl: text("linear_issue_url"),
    failureReason: text("failure_reason"),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("issue_linear_tickets_issue_idx").on(table.issueId),
    index("issue_linear_tickets_investigation_idx").on(table.investigationId),
    index("issue_linear_tickets_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
  ],
);

export const investigationIssues = pgTable(
  "investigation_issues",
  {
    investigationId: uuid("investigation_id")
      .notNull()
      .references(() => investigations.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    relationship: issueRelationship("relationship").notNull(),
    evidence: jsonb("evidence").$type<IssueEvidence[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.investigationId, table.issueId] }),
    index("investigation_issues_issue_idx").on(table.issueId),
  ],
);

export const webhookReceipts = pgTable(
  "webhook_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalEventId: text("external_event_id").notNull(),
    investigationId: uuid("investigation_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("webhook_receipts_provider_event_idx").on(
      table.provider,
      table.externalEventId,
    ),
  ],
);

export const deliveryAttempts = pgTable(
  "delivery_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    investigationId: uuid("investigation_id")
      .notNull()
      .references(() => investigations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    destination: text("destination").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    externalId: text("external_id"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("delivery_attempts_idempotency_idx").on(table.idempotencyKey),
    index("delivery_attempts_investigation_idx").on(table.investigationId),
  ],
);

export const billingNotificationDeliveries = pgTable(
  "billing_notification_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    integrationAccountId: uuid("integration_account_id")
      .notNull()
      .references(() => integrationAccounts.id, { onDelete: "cascade" }),
    periodKey: text("period_key").notNull(),
    kind: text("kind").notNull(),
    destination: text("destination").notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("billing_notification_delivery_target_idx").on(
      table.organizationId,
      table.periodKey,
      table.integrationAccountId,
      table.kind,
      table.destination,
    ),
    index("billing_notification_delivery_status_idx").on(
      table.organizationId,
      table.status,
    ),
  ],
);
