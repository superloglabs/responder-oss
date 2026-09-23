import { z } from "zod";

export const automationHarnessSchema = z.enum([
  "codex",
  "claude_agent_sdk",
  "opencode",
]);

export const automationModelProviderSchema = z.enum(["openai", "anthropic"]);

const externalResourceIdSchema = z.string().trim().min(1).max(255);
const integrationAccountIdSchema = z.uuid();

export const automationTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    channelIds: z.array(externalResourceIdSchema).min(1).max(50),
    eventMode: z.enum(["mentions", "every_message", "both"]),
    integrationAccountId: integrationAccountIdSchema,
    kind: z.literal("slack"),
  }),
  z.object({
    eventTypes: z.array(z.enum(["new_issue", "regression"])).min(1).max(2),
    integrationAccountId: integrationAccountIdSchema,
    kind: z.literal("sentry"),
    projectIds: z.array(externalResourceIdSchema).min(1).max(100),
  }),
  z.object({
    channelIds: z.array(externalResourceIdSchema).min(1).max(50),
    integrationAccountId: integrationAccountIdSchema,
    kind: z.literal("discord"),
  }),
]);

export const automationConfigurationSchema = z
  .object({
    contextAccountIds: z.array(z.uuid()).max(50).default([]),
    harness: automationHarnessSchema,
    maxModelRequests: z.number().int().min(1).max(128),
    maxOutputTokensPerRequest: z.number().int().min(256).max(100_000),
    maxRuntimeSeconds: z.number().int().min(60).max(3_600),
    model: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u),
    modelCredentialId: z.uuid(),
    modelProvider: automationModelProviderSchema,
    prompt: z.string().trim().min(1).max(50_000),
    repositoryIds: z.array(z.uuid()).min(1).max(10),
    toolPolicy: z.literal("full"),
    trigger: automationTriggerSchema,
    workspaceSecretIds: z.array(z.uuid()).max(20).default([]),
  })
  .superRefine((configuration, context) => {
    if (
      configuration.harness === "claude_agent_sdk" &&
      configuration.modelProvider !== "anthropic"
    ) {
      context.addIssue({
        code: "custom",
        message: "Claude Agent SDK requires an Anthropic model credential",
        path: ["modelProvider"],
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
export type AutomationInput = z.infer<typeof automationInputSchema>;
export type AutomationModelProvider = z.infer<
  typeof automationModelProviderSchema
>;
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;
