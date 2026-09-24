import { z } from "zod";
import { automationModelProviders, supportsAutomationHarness } from "./model-providers.js";

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
]);

export const automationConfigurationSchema = z
  .object({
    contextAccountIds: z.array(z.uuid()).max(50).default([])
      .refine(uniqueIds, "Context account IDs must be unique"),
    harness: automationHarnessSchema,
    maxModelRequests: z.number().int().min(1).max(128),
    maxOutputTokensPerRequest: z.number().int().min(256).max(100_000),
    maxRuntimeSeconds: z.number().int().min(60).max(3_600),
    model: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u),
    modelCredentialId: z.uuid().nullable().default(null),
    modelProvider: automationModelProviderSchema,
    prompt: z.string().trim().min(1).max(50_000),
    repositoryIds: z.array(z.uuid()).min(1).max(10)
      .refine(uniqueIds, "Repository IDs must be unique"),
    toolPolicy: z.literal("full"),
    trigger: automationTriggerSchema,
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
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;
