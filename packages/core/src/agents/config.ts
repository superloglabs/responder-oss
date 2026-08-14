import { z } from "zod";

const integrationAccountId = z.uuid("Choose a connected account");
const externalResourceId = z.string().trim().min(1);
const reportSeverity = z.enum(["SEV-1", "SEV-2", "SEV-3"]);
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
    instructions: z.string().trim().min(1, "Instructions are required").max(20_000),
    enabled: z.boolean().default(true),
    prMode: agentPrModeSchema.default("disabled"),
    repositoryIds: z.array(z.uuid()).max(100).default([]),
    contextAccountIds: z.array(z.uuid()).max(20).default([]),
    contextResourceIds: z.array(z.uuid()).max(100).default([]),
    secretIds: z.array(z.uuid()).max(20).default([]),
    trigger: agentTriggerSchema,
    reporting: agentReportingSchema,
  })
  .superRefine((configuration, context) => {
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

export type AgentConfigurationInput = z.input<typeof agentConfigurationSchema>;
export type AgentConfiguration = z.output<typeof agentConfigurationSchema>;
export type AgentTrigger = AgentConfiguration["trigger"];
export type AgentReporting = AgentConfiguration["reporting"];
