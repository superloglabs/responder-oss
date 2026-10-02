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
      .refine(uniqueIds, "Channel IDs must be unique"),
    eventMode: z.enum(["mentions", "every_message", "both"]),
    integrationAccountId: integrationAccountIdSchema,
    kind: z.literal("slack"),
  }),
  z.object({
    eventTypes: z.array(z.enum(["new_issue", "regression"])).min(1).max(2)
      .refine(uniqueIds, "Event types must be unique"),
    // Issues whose triggering event comes from one of these environments do
    // not start a run. Environments added later in Sentry are included.
    excludedEnvironments: z.array(z.string().trim().min(1).max(64)).max(100)
      .refine(uniqueIds, "Environments must be unique").optional(),
    integrationAccountId: integrationAccountIdSchema,
    kind: z.literal("sentry"),
    projectIds: z.array(externalResourceIdSchema).min(1).max(100)
      .refine(uniqueIds, "Project IDs must be unique"),
  }),
  z.object({
    channelIds: z.array(externalResourceIdSchema).min(1).max(50)
      .refine(uniqueIds, "Channel IDs must be unique"),
    integrationAccountId: integrationAccountIdSchema,
    kind: z.literal("discord"),
  }),
  z.object({
    frequency: z.enum(["hourly", "daily", "weekly"]),
    hour: z.number().int().min(0).max(23),
    kind: z.literal("schedule"),
    timezone: z.string().min(1).max(64).refine(isValidTimeZone, "Choose a valid time zone"),
    weekday: z.number().int().min(0).max(6),
  }),
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
