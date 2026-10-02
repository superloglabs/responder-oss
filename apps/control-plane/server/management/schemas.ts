import { z } from "zod";
import {
  automationConfigurationSchema,
  automationHarnessSchema,
  automationModelProviderSchema,
  automationNotificationSchema,
  automationTriggerSchema,
  defaultAutomationModelSettings,
} from "../../../../packages/core/src/automations/config.js";
import { slackThreadModeConfigurationSchema } from "../../../../packages/core/src/agents/config.js";

// Request and response shapes of the management API. Responses are parsed
// with these schemas before they are sent, so only documented fields leave
// the server.

const id = (description: string) => z.uuid().describe(description);
const timestamp = (description: string) =>
  z.iso.datetime({ offset: true }).describe(description);

export const errorSchema = z
  .object({
    code: z.string().optional().describe("A stable machine-readable error code, when there is one."),
    error: z.string().describe("What went wrong."),
    issues: z
      .array(
        z.object({
          message: z.string(),
          path: z.array(z.union([z.string(), z.number()])),
        }),
      )
      .optional()
      .describe("Validation problems, one per invalid field."),
  });

const memberSchema = z.object({
  email: z.string(),
  id: id("Membership ID."),
  joinedAt: timestamp("When the person joined the workspace."),
  name: z.string(),
  role: z.string().describe("`owner`, `admin`, or `member`."),
  userId: id("User ID."),
});

export const workspaceSchema = z.object({
  workspace: z.object({
    apiKeyId: id("The API key used for this request."),
    capabilities: z.array(z.string()).describe("Features enabled for this workspace, such as `automations`."),
    createdAt: timestamp("When the workspace was created."),
    id: id("Workspace ID."),
    member: z
      .object({
        email: z.string(),
        name: z.string(),
        role: z.string(),
        userId: id("User ID."),
      })
      .describe("The member this API key acts as. Changes are recorded under their name."),
    name: z.string(),
    slug: z.string(),
  }),
});

export const membersSchema = z.object({
  invitations: z.array(
    z.object({
      createdAt: timestamp("When the invitation was sent."),
      email: z.string(),
      expiresAt: timestamp("When the invitation expires."),
      id: id("Invitation ID."),
      role: z.string(),
    }),
  ).describe("Invitations that have not been accepted and have not expired."),
  members: z.array(memberSchema),
});

const apiKeySchema = z
  .object({
    createdAt: timestamp("When the key was created."),
    createdBy: z.object({ email: z.string(), id: id("User ID."), name: z.string() })
      .describe("The member the key acts as."),
    id: id("API key ID."),
    lastUsedAt: timestamp("When the key was last used, to the minute.").nullable(),
    name: z.string(),
    prefix: z.string().describe("The first characters of the key."),
  });

export const apiKeysSchema = z.object({ apiKeys: z.array(apiKeySchema) });

export const integrationsSchema = z.object({
  integrations: z.array(
    z.object({
      displayName: z.string(),
      id: id("Integration account ID. Use it as `integrationAccountId` in triggers and notifications, and in `contextAccountIds`."),
      provider: z.string().describe("For example `github`, `slack`, `sentry`, or `linear`."),
    }),
  ),
  repositories: z.array(
    z.object({
      defaultBranch: z.string(),
      fullName: z.string().describe("`owner/name`."),
      id: id("Repository ID. Use it in `repositoryIds`."),
      integrationAccountId: id("The GitHub integration that grants access."),
      private: z.boolean(),
    }),
  ),
  resources: z.array(
    z.object({
      displayName: z.string(),
      externalId: z.string().describe("The provider's ID, such as a Slack channel ID or Sentry project ID. Triggers and notifications use this value."),
      id: id("Resource ID. Tag mode uses it in `contextResourceIds`."),
      integrationAccountId: id("The integration the resource belongs to."),
      kind: z.string().describe("For example `slack_channel`, `sentry_project`, `discord_channel`, or `vercel_project`."),
    }),
  ),
});

export const sentryEnvironmentsSchema = z.object({
  environments: z.array(z.string()),
});

const configurationShape = automationConfigurationSchema.shape;

export const automationConfigurationOutputSchema = z
  .object({
    contextAccountIds: z.array(z.uuid())
      .describe("Integration accounts the agent can read from, besides GitHub."),
    harness: automationHarnessSchema.describe("The agent program that runs the model."),
    maxModelRequests: z.number().int().describe("Most model requests in one run."),
    maxOutputTokensPerRequest: z.number().int(),
    maxRuntimeSeconds: z.number().int(),
    model: z.string(),
    modelProvider: automationModelProviderSchema,
    notifications: z.array(automationNotificationSchema)
      .describe("Slack channels that receive the result of scheduled and Sentry runs."),
    prompt: z.string().describe("The agent instructions."),
    repositoryIds: z.array(z.uuid()),
    toolPolicy: z.literal("full"),
    triggers: z.array(automationTriggerSchema),
    workspaceSecretIds: z.array(z.uuid()),
  });

const describedConfigurationShape = {
  ...configurationShape,
  contextAccountIds: configurationShape.contextAccountIds
    .describe("Integration account IDs the agent can read from, besides GitHub. See `GET /integrations`."),
  notifications: configurationShape.notifications
    .describe("Slack channels that receive the result of each scheduled or Sentry run."),
  prompt: configurationShape.prompt.describe("The agent instructions."),
  repositoryIds: configurationShape.repositoryIds
    .describe("Repositories checked out in the sandbox. See `GET /integrations`."),
  triggers: configurationShape.triggers
    .describe("What starts a run. Each trigger starts runs on its own."),
  workspaceSecretIds: configurationShape.workspaceSecretIds
    .describe("Workspace secrets available to the agent. See `GET /secrets`."),
};

function withDefault<Schema extends z.ZodType>(
  schema: Schema,
  key: keyof typeof defaultAutomationModelSettings,
) {
  return schema
    .optional()
    .describe(`Defaults to \`${defaultAutomationModelSettings[key]}\`.`);
}

// Model settings may be left out of a new automation and use the defaults.
export const automationConfigurationInputSchema = z
  .object({
    ...describedConfigurationShape,
    harness: withDefault(configurationShape.harness, "harness"),
    maxModelRequests: withDefault(configurationShape.maxModelRequests, "maxModelRequests"),
    maxOutputTokensPerRequest: withDefault(
      configurationShape.maxOutputTokensPerRequest,
      "maxOutputTokensPerRequest",
    ),
    maxRuntimeSeconds: withDefault(configurationShape.maxRuntimeSeconds, "maxRuntimeSeconds"),
    model: withDefault(configurationShape.model, "model"),
    modelProvider: withDefault(configurationShape.modelProvider, "modelProvider"),
    toolPolicy: withDefault(configurationShape.toolPolicy, "toolPolicy"),
  });

// A field left out of a change keeps its current value, so defaults must not
// fill it in. The complete result is validated again before it is saved.
function changed<Schema extends z.ZodType>(schema: Schema) {
  const inner = schema instanceof z.ZodDefault
    ? (schema.unwrap() as z.ZodType)
    : schema;
  const optional = inner.optional();
  return (schema.description ? optional.describe(schema.description) : optional) as z.ZodOptional<
    Schema extends z.ZodDefault<infer Inner> ? Inner : Schema
  >;
}

const shape = describedConfigurationShape;
export const automationConfigurationChangesSchema = z
  .object({
    contextAccountIds: changed(shape.contextAccountIds),
    harness: changed(shape.harness),
    maxModelRequests: changed(shape.maxModelRequests),
    maxOutputTokensPerRequest: changed(shape.maxOutputTokensPerRequest),
    maxRuntimeSeconds: changed(shape.maxRuntimeSeconds),
    model: changed(shape.model),
    modelProvider: changed(shape.modelProvider),
    notifications: changed(shape.notifications),
    prompt: changed(shape.prompt),
    repositoryIds: changed(shape.repositoryIds),
    toolPolicy: changed(shape.toolPolicy),
    triggers: changed(shape.triggers),
    workspaceSecretIds: changed(shape.workspaceSecretIds),
  })
  .describe("Configuration fields to replace. Fields you leave out keep their current value; a list you include replaces the whole list.");

const lastRunSchema = z.object({
  createdAt: timestamp("When the run was created."),
  status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
});

const automationSummarySchema = z
  .object({
    connectors: z.array(z.string()).describe("Providers the automation uses, such as `github` and `sentry`."),
    createdAt: timestamp("When the automation was created."),
    description: z.string(),
    enabled: z.boolean(),
    harness: automationHarnessSchema,
    id: id("Automation ID."),
    lastRun: lastRunSchema.nullable(),
    model: z.string(),
    modelProvider: automationModelProviderSchema,
    name: z.string(),
    triggers: z.array(automationTriggerSchema),
    updatedAt: timestamp("When the automation was last changed."),
    version: z.number().int().describe("Increases each time the configuration is saved."),
  });

export const automationListSchema = z.object({
  automations: z.array(automationSummarySchema),
});

export const automationSchema = z
  .object({
    configuration: automationConfigurationOutputSchema,
    createdAt: timestamp("When the automation was created."),
    description: z.string(),
    enabled: z.boolean(),
    id: id("Automation ID."),
    name: z.string(),
    updatedAt: timestamp("When the automation was last changed."),
    version: z.number().int().describe("Increases each time the configuration is saved."),
  });

export const automationResponseSchema = z.object({ automation: automationSchema });

const runStatusSchema = z
  .enum(["pending", "running", "succeeded", "failed", "cancelled"])
  .describe("`pending` and `running` runs are active.");

const inferenceUsageSchema = z
  .object({
    costMicros: z.number().int().nullable()
      .describe("Model cost in millionths of a US dollar. Null when a price is unknown."),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    requests: z.number().int(),
  })
  .nullable();

const runTriggerSchema = z.object({
  provider: z.string().describe("What started the run: `manual`, `schedule`, `slack`, `sentry`, or `discord`."),
  sourceUrl: z.string().nullable().describe("A link to the event that started the run."),
  title: z.string(),
});

const runSummarySchema = z
  .object({
    completedAt: timestamp("When the run finished.").nullable(),
    createdAt: timestamp("When the run was created."),
    failureCategory: z.string().nullable(),
    failureMessage: z.string().nullable(),
    id: id("Run ID."),
    inferenceUsage: inferenceUsageSchema,
    number: z.number().int().describe("The run's position in the automation's history, starting at 1."),
    resultSummary: z.string().nullable().describe("The agent's final answer."),
    startedAt: timestamp("When the run started.").nullable(),
    status: runStatusSchema,
    trigger: runTriggerSchema,
  });

export const runListSchema = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  runs: z.array(runSummarySchema),
  total: z.number().int().describe("Runs across all pages."),
});

export const runSchema = z
  .object({
    automationId: id("Automation ID."),
    automationName: z.string(),
    cancelRequestedAt: timestamp("When cancellation was requested.").nullable(),
    completedAt: timestamp("When the run finished.").nullable(),
    createdAt: timestamp("When the run was created."),
    events: z.array(
      z.object({
        createdAt: timestamp("When the event was recorded."),
        data: z.record(z.string(), z.unknown()).nullable(),
        id: z.number().int(),
        type: z.string().describe("For example `transcript`, `user_message`, or `action_succeeded`."),
      }),
    ).describe("The run's transcript and actions, oldest first."),
    failureCategory: z.string().nullable(),
    failureMessage: z.string().nullable(),
    id: id("Run ID."),
    inferenceUsage: inferenceUsageSchema,
    number: z.number().int(),
    resultSummary: z.string().nullable(),
    startedAt: timestamp("When the run started.").nullable(),
    status: runStatusSchema,
    trigger: runTriggerSchema.extend({
      attributes: z.record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.null()]),
      ).describe("Details of the triggering event, such as a Slack channel or Sentry issue."),
    }),
  });

export const runResponseSchema = z.object({ run: runSchema });

export const tagModeSchema = z
  .object({
    contextAccountIds: z.array(z.uuid()),
    contextResourceIds: z.array(z.uuid()),
    enabled: z.boolean(),
    instructions: z.string(),
    model: z.string(),
    repositoryIds: z.array(z.uuid()),
    secretIds: z.array(z.uuid()),
  });

const tagModeShape = slackThreadModeConfigurationSchema.shape;

export const tagModeChangesSchema = z.object({
  contextAccountIds: changed(tagModeShape.contextAccountIds)
    .describe("Integration account IDs tag mode can read from."),
  contextResourceIds: changed(tagModeShape.contextResourceIds)
    .describe("Resource IDs, such as Vercel projects, tag mode can read from."),
  enabled: changed(tagModeShape.enabled),
  instructions: changed(tagModeShape.instructions)
    .describe("The prompt tag mode follows for every request."),
  model: changed(tagModeShape.model),
  repositoryIds: changed(tagModeShape.repositoryIds)
    .describe("Repositories tag mode can read."),
  secretIds: changed(tagModeShape.secretIds)
    .describe("Workspace secrets tag mode can use."),
});

export const tagModeResponseSchema = z.object({ tagMode: tagModeSchema.nullable() });

const modelSchema = z.object({ id: z.string(), name: z.string() });
export const modelListSchema = z.object({ models: z.array(modelSchema) });

const modelCredentialSchema = z
  .object({
    authType: z.enum(["api_key", "chatgpt_subscription"]),
    createdAt: timestamp("When the credential was added."),
    id: id("Model credential ID."),
    label: z.string(),
    lastFour: z.string().describe("The last four characters of the API key."),
    lastValidatedAt: timestamp("When the credential was last tested.").nullable(),
    provider: automationModelProviderSchema,
    status: z.enum(["active", "invalid"]),
    updatedAt: timestamp("When the credential was last changed."),
  });

export const modelCredentialListSchema = z.object({
  modelCredentials: z.array(modelCredentialSchema),
});
export const modelCredentialResponseSchema = z.object({
  modelCredential: modelCredentialSchema,
});

const secretSchema = z
  .object({
    allowedHosts: z.array(z.string()),
    createdAt: timestamp("When the secret was stored."),
    id: id("Workspace secret ID."),
    name: z.string().describe("The environment variable name."),
  });

export const secretListSchema = z.object({ secrets: z.array(secretSchema) });
export const secretResponseSchema = z.object({ secret: secretSchema });
