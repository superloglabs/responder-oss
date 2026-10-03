import { z } from "zod";
import { automationModelProviders, supportsAutomationHarness } from "./model-providers.js";
import { isValidTimeZone } from "./schedule.js";

export const automationHarnessSchema = z.enum([
  "codex",
  "claude_agent_sdk",
  "opencode",
]);

export const automationModelProviderSchema = z.enum(automationModelProviders.map(provider => provider.id));

// Responder-funded inference is the default. An organization API key or a
// ChatGPT subscription replaces it and does not draw on the usage allowance.
export const automationInferenceSourceSchema = z.enum([
  "responder",
  "byok",
  "byos",
]);

const externalResourceIdSchema = z.string().trim().min(1).max(255);
const integrationAccountIdSchema = z.uuid();
const uniqueIds = (ids: string[]) => new Set(ids).size === ids.length;

export const automationTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    channelIds: z.array(externalResourceIdSchema).min(1).max(50)
      .refine(uniqueIds, "Channel IDs must be unique")
      .describe("Slack channel IDs, such as C0123456789."),
    eventMode: z.enum(["mentions", "every_message", "both"])
      .describe("Run when the app is mentioned, on every new message, or both."),
    // Messages from these people and apps neither start a run nor reach a
    // run as replies. The name is what the trigger editor shows.
    ignoredAuthors: z.array(z.object({
      id: externalResourceIdSchema
        .describe("Slack user ID, such as U0123456789, or app ID, such as A0123456789."),
      name: z.string().trim().min(1).max(255),
    })).max(100)
      .refine((authors) => uniqueIds(authors.map((author) => author.id)), "Ignored authors must be unique")
      .optional()
      .describe("Slack people and apps whose messages do not start or continue a run."),
    integrationAccountId: integrationAccountIdSchema,
    kind: z.literal("slack"),
  }).describe("Runs on Slack messages in the selected channels."),
  z.object({
    eventTypes: z.array(z.enum(["new_issue", "regression"])).min(1).max(2)
      .refine(uniqueIds, "Event types must be unique")
      .describe("Run on new issues, regressions, or both."),
    // Issues whose triggering event comes from one of these environments do
    // not start a run. Environments added later in Sentry are included.
    excludedEnvironments: z.array(z.string().trim().min(1).max(64)).max(100)
      .refine(uniqueIds, "Environments must be unique").optional()
      .describe("Issues from these environments do not start a run."),
    integrationAccountId: integrationAccountIdSchema,
    kind: z.literal("sentry"),
    projectIds: z.array(externalResourceIdSchema).min(1).max(100)
      .refine(uniqueIds, "Project IDs must be unique")
      .describe("Sentry project IDs."),
  }).describe("Runs on new or regressed Sentry issues in the selected projects."),
  z.object({
    channelIds: z.array(externalResourceIdSchema).min(1).max(50)
      .refine(uniqueIds, "Channel IDs must be unique")
      .describe("Discord channel IDs."),
    integrationAccountId: integrationAccountIdSchema,
    kind: z.literal("discord"),
  }).describe("Runs when someone uses `/automate` in the selected Discord channels."),
  z.object({
    frequency: z.enum(["hourly", "daily", "weekly"]),
    hour: z.number().int().min(0).max(23)
      .describe("Local hour for daily and weekly runs, 0 to 23."),
    kind: z.literal("schedule"),
    timezone: z.string().min(1).max(64).refine(isValidTimeZone, "Choose a valid time zone")
      .describe("IANA time zone, such as Europe/Paris."),
    weekday: z.number().int().min(0).max(6)
      .describe("Local day for weekly runs. 0 is Sunday."),
  }).describe("Runs on the hour, or at a local time each day or week."),
]);

// Where a scheduled or Sentry-triggered automation reports each finished run.
// Slack only for now.
export const automationNotificationSchema = z.discriminatedUnion("kind", [
  z.object({
    channelId: externalResourceIdSchema,
    integrationAccountId: integrationAccountIdSchema,
    kind: z.literal("slack"),
  }),
]);

// Slack and Discord runs answer where their event came from. Scheduled and
// Sentry runs have no reply thread, so they report to notification channels.
export function automationTriggersNotify(triggers: Array<{ kind: AutomationTrigger["kind"] }>): boolean {
  return triggers.some((trigger) => trigger.kind === "schedule" || trigger.kind === "sentry");
}

export const automationConfigurationSchema = z
  .object({
    contextAccountIds: z.array(z.uuid()).max(50).default([])
      .refine(uniqueIds, "Context account IDs must be unique"),
    harness: automationHarnessSchema,
    maxModelRequests: z.number().int().min(1).max(1_000),
    maxOutputTokensPerRequest: z.number().int().min(256).max(100_000),
    maxRuntimeSeconds: z.number().int().min(60).max(3_600),
    model: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u),
    modelProvider: automationModelProviderSchema,
    notifications: z.array(automationNotificationSchema).max(10).default([])
      .refine(
        (notifications) => uniqueIds(notifications.map((notification) =>
          `${notification.integrationAccountId}:${notification.channelId}`)),
        "Each notification needs a different channel",
      ),
    prompt: z.string().trim().min(1).max(50_000),
    repositoryIds: z.array(z.uuid()).min(1).max(10)
      .refine(uniqueIds, "Repository IDs must be unique"),
    toolPolicy: z.literal("full"),
    // Every trigger starts a run on its own.
    triggers: z.array(automationTriggerSchema).min(1).max(10),
    workspaceSecretIds: z.array(z.uuid()).max(20).default([])
      .refine(uniqueIds, "Workspace secret IDs must be unique"),
  })
  .superRefine((configuration, context) => {
    if (
      !supportsAutomationHarness(configuration.modelProvider, configuration.harness)
    ) {
      context.addIssue({
        code: "custom",
        message: configuration.harness === "claude_agent_sdk" ? "Claude Agent SDK requires an Anthropic model" : "The selected harness does not support this model provider",
        path: ["modelProvider"],
      });
    }
    if (
      configuration.notifications.length > 0 &&
      !automationTriggersNotify(configuration.triggers)
    ) {
      context.addIssue({
        code: "custom",
        message: "Notifications are only available for scheduled and Sentry automations",
        path: ["notifications"],
      });
    }
  });

export const automationInputSchema = z.object({
  configuration: automationConfigurationSchema,
  description: z.string().trim().max(2_000).default(""),
  enabled: z.boolean().default(true),
  name: z.string().trim().min(1).max(120),
});

// The model and limits a new automation starts with.
export const defaultAutomationModelSettings = {
  harness: "codex",
  maxModelRequests: 500,
  maxOutputTokensPerRequest: 16_000,
  maxRuntimeSeconds: 1_800,
  model: "gpt-5.4",
  modelProvider: "openai",
  toolPolicy: "full",
} as const;

export type AutomationConfiguration = z.infer<
  typeof automationConfigurationSchema
>;
export type AutomationHarnessKind = z.infer<typeof automationHarnessSchema>;
export type AutomationInferenceSource = z.infer<
  typeof automationInferenceSourceSchema
>;
export type AutomationInput = z.infer<typeof automationInputSchema>;
export type AutomationModelProvider = z.infer<
  typeof automationModelProviderSchema
>;
export type AutomationNotification = z.infer<typeof automationNotificationSchema>;
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;
