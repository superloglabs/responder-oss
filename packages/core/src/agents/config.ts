import { z } from "zod";

const integrationAccountId = z.uuid("Choose a connected account");
const externalResourceId = z.string().trim().min(1);
const reportSeverity = z.enum(["SEV-1", "SEV-2", "SEV-3"]);
export const AGENT_PROMPT_MAX_LENGTH = 400_000;
export const defaultLinearIssueTemplate = [
  "## Responder issue",
  "[{{issue_id}}]({{issue_url}})",
  "",
  "## Description",
  "{{description}}",
  "",
  "## Evidence",
  "{{evidence}}",
  "",
  "## Recommended remediation",
  "{{remediation}}",
].join("\n");
export const agentPrModeSchema = z
  .union([z.enum(["disabled", "manual", "always"]), z.boolean()])
  .transform((mode) =>
    typeof mode === "boolean" ? (mode ? "always" : "disabled") : mode,
  );

export const agentTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sentry_issue"),
    integrationAccountId,
    projectIds: z.array(externalResourceId).min(1, "Choose at least one Sentry project"),
  }),
  z.object({
    kind: z.literal("datadog_monitor"),
    integrationAccountId,
    monitorIds: z.array(externalResourceId).min(1, "Choose at least one Datadog monitor"),
  }),
  z.object({
    kind: z.literal("dash0_alert"),
    integrationAccountId,
  }),
  z.object({
    kind: z.literal("slack_channel"),
    integrationAccountId,
    channelId: externalResourceId,
  }),
  z.object({
    kind: z.literal("slack_mention"),
    integrationAccountId,
    channelIds: z.array(externalResourceId).default([]),
  }),
]);

export const agentReportingSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("thread"),
  }),
  z.object({
    mode: z.literal("output_channel"),
    integrationAccountId,
    outputChannelId: externalResourceId,
    severities: z.array(reportSeverity).min(1).max(3).optional(),
  }),
  z.object({
    mode: z.literal("both"),
    integrationAccountId,
    outputChannelId: externalResourceId,
    severities: z.array(reportSeverity).min(1).max(3).optional(),
  }),
]);

export const agentConfigurationSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(80),
    description: z.string().trim().max(500).default(""),
    model: z.string().trim().min(1, "Model is required").max(160),
    instructions: z
      .string()
      .trim()
      .min(1, "Instructions are required")
      .max(AGENT_PROMPT_MAX_LENGTH),
    enabled: z.boolean().default(true),
    prMode: agentPrModeSchema.default("disabled"),
    repositoryIds: z.array(z.uuid()).max(100).default([]),
    contextAccountIds: z.array(z.uuid()).max(20).default([]),
    contextResourceIds: z.array(z.uuid()).max(100).default([]),
    secretIds: z.array(z.uuid()).max(20).default([]),
    initialTriageEnabled: z.boolean().default(false),
    createLinearTickets: z.boolean().default(false),
    linearIssueTemplate: z
      .string()
      .max(10_000)
      .default(defaultLinearIssueTemplate),
    trigger: agentTriggerSchema,
    reporting: agentReportingSchema,
  })
  .superRefine((configuration, context) => {
    if (
      configuration.initialTriageEnabled &&
      configuration.trigger.kind !== "slack_channel"
    ) {
      context.addIssue({
        code: "custom",
        message: "Initial triage requires a Slack channel trigger",
        path: ["initialTriageEnabled"],
      });
    }
    if (
      configuration.createLinearTickets &&
      !configuration.linearIssueTemplate.trim()
    ) {
      context.addIssue({
        code: "custom",
        message: "Linear issue template is required",
        path: ["linearIssueTemplate"],
      });
    }
    if (
      configuration.prMode !== "disabled" &&
      configuration.repositoryIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Choose at least one repository when remediation is enabled",
        path: ["repositoryIds"],
      });
    }
    if (
      (configuration.reporting.mode === "thread" ||
        configuration.reporting.mode === "both") &&
      configuration.trigger.kind !== "slack_channel" &&
      configuration.trigger.kind !== "slack_mention"
    ) {
      context.addIssue({
        code: "custom",
        message: "Thread reporting requires a Slack trigger",
        path: ["reporting", "mode"],
      });
    }
  });

// Tag mode's starting prompt. Workspaces with simplified navigation use the
// assistant prompt and treat the earlier investigation prompt as unchanged.
export const tagModeInvestigationInstructions =
  "Investigate the request using connected context and attached repositories. Report what you found, the supporting evidence, and the recommended next step.";
export const tagModeAssistantInstructions =
  "Answer the request using the connected integrations and attached repositories. Keep replies short, and say what you changed.";

export function customTagModeInstructions(instructions: string): string | null {
  return instructions.trim() === tagModeInvestigationInstructions ? null : instructions;
}

export const slackThreadModeConfigurationSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().trim().min(1, "Model is required").max(160),
  instructions: z
    .string()
    .trim()
    .min(1, "Instructions are required")
    .max(AGENT_PROMPT_MAX_LENGTH),
  repositoryIds: z.array(z.uuid()).max(100).default([]),
  contextAccountIds: z.array(z.uuid()).max(20).default([]),
  contextResourceIds: z.array(z.uuid()).max(100).default([]),
  secretIds: z.array(z.uuid()).max(20).default([]),
});

// Integrations an agent or tag mode can use as context.
export const contextIntegrationProviders = [
  "aws",
  "gcp",
  "sentry",
  "datadog",
  "dash0",
  "posthog",
  "grafana",
  "axiom",
  "clickstack",
  "upstash",
  "langfuse",
  "supabase",
  "vercel",
  "custom_mcp",
  "linear",
] as const;

// Tag mode that has never been saved starts on, with every connected context
// integration and every Vercel project, up to the configuration limits.
// Over the account limit, each provider keeps one account before any keeps a
// second. Repositories and secrets are still chosen by hand.
export function defaultSlackThreadModeConfiguration(input: {
  instructions: string;
  options: {
    accounts: { id: string; provider: string; displayName: string }[];
    resources: {
      id: string;
      integrationAccountId: string;
      kind: string;
      displayName: string;
    }[];
  };
}): SlackThreadModeConfiguration {
  const byName = (
    left: { id: string; displayName: string },
    right: { id: string; displayName: string },
  ) =>
    left.displayName.localeCompare(right.displayName) ||
    left.id.localeCompare(right.id);
  const contextAccountIds = contextIntegrationProviders
    .flatMap((provider, order) =>
      input.options.accounts
        .filter((account) => account.provider === provider)
        .sort(byName)
        .map((account, rank) => ({ id: account.id, order, rank })),
    )
    .sort((left, right) => left.rank - right.rank || left.order - right.order)
    .map((account) => account.id)
    .slice(0, 20);
  const contextResourceIds = input.options.resources
    .filter(
      (resource) =>
        resource.kind === "vercel_project" &&
        contextAccountIds.includes(resource.integrationAccountId),
    )
    .sort(byName)
    .map((resource) => resource.id)
    .slice(0, 100);
  return {
    enabled: true,
    model: "instance/default",
    instructions: input.instructions,
    repositoryIds: [],
    contextAccountIds,
    contextResourceIds,
    secretIds: [],
  };
}

export type AgentConfigurationInput = z.input<typeof agentConfigurationSchema>;
export type AgentConfiguration = z.output<typeof agentConfigurationSchema>;
export type AgentTrigger = AgentConfiguration["trigger"];
export type AgentReporting = AgentConfiguration["reporting"];
export type SlackThreadModeConfiguration = z.output<
  typeof slackThreadModeConfigurationSchema
>;
