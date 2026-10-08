import { integrationConnectionOperations } from "./integration-connections.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  defaultSlackThreadModeConfiguration,
  slackThreadModeConfigurationSchema,
  tagModeAssistantInstructions,
  tagModeInvestigationInstructions,
} from "../../../../packages/core/src/agents/config.js";
import { captureAnalyticsEvent } from "../../../../packages/core/src/analytics.js";
import {
  automationInputSchema,
  automationModelProviderSchema,
  defaultAutomationModelSettings,
  type AutomationInput,
} from "../../../../packages/core/src/automations/config.js";
import {
  listProviderModels,
  ModelCatalogError,
} from "../../../../packages/core/src/automations/model-catalog.js";
import { listAIGatewayModels } from "../../../../packages/core/src/automations/model-pricing.js";
import { automationUserMessageMaxLength } from "../../../../packages/core/src/automations/transcript.js";
import {
  AgentConfigurationError,
  disableAgentsWithUnavailableRepositories,
  getSlackThreadModeConfiguration,
  listAgentOptions,
  saveSlackThreadModeConfiguration,
} from "../../../../packages/core/src/db/agents.js";
import { listApiKeys, revokeApiKey } from "../../../../packages/core/src/db/api-keys.js";
import {
  createOrganizationModelCredential,
  deleteOrganizationModelCredential,
  getOrganizationModelCredential,
  getOrganizationModelCredentialForValidation,
  listOrganizationModelCredentials,
  markOrganizationModelCredentialValidated,
  rotateOrganizationModelCredential,
} from "../../../../packages/core/src/db/automation-model-credentials.js";
import {
  AutomationConfigurationError,
  createAutomation,
  getAutomation,
  getAutomationRun,
  listAutomationRuns,
  listAutomations,
  requestAutomationRunCancellation,
  setAutomationEnabled,
  updateAutomation,
} from "../../../../packages/core/src/db/automations.js";
import { getOrganizationIntegrationAccount } from "../../../../packages/core/src/db/integrations.js";
import { listEnabledOrganizationCapabilities } from "../../../../packages/core/src/db/organization-capabilities.js";
import {
  getOrganizationSummary,
  listOrganizationMembers,
} from "../../../../packages/core/src/db/organizations.js";
import { listWorkspaceSecrets } from "../../../../packages/core/src/db/workspace-secrets.js";
import { refreshGitHubRepositories } from "../agents/routes.js";
import {
  storeWorkspaceSecret,
  workspaceSecretInputSchema,
} from "../agents/workspace-secrets.js";
import { queueAutomationRun, queueAutomationRunFollowUp } from "../automations/queue.js";
import { listSubscriptionModels } from "../automations/subscription-models.js";
import { listSentryEnvironments } from "../integrations/sentry.js";
import {
  getFreshSentryCredentials,
  getSentryOrganizationSlug,
} from "../integrations/sentry-credentials.js";
import { refreshSlackChannelResources } from "../integrations/slack-resources.js";
import {
  defineOperation,
  ManagementError,
  type ManagementContext,
  type ManagementOperation,
} from "./operation.js";
import {
  apiKeysSchema,
  automationConfigurationChangesSchema,
  automationConfigurationInputSchema,
  automationListSchema,
  automationResponseSchema,
  integrationsSchema,
  membersSchema,
  modelCredentialListSchema,
  modelCredentialResponseSchema,
  modelListSchema,
  runListSchema,
  runResponseSchema,
  secretListSchema,
  secretResponseSchema,
  sentryEnvironmentsSchema,
  tagModeChangesSchema,
  tagModeResponseSchema,
  workspaceSchema,
} from "./schemas.js";

const automationId = z.uuid().describe("Automation ID.");
const runId = z.uuid().describe("Run ID.");
const credentialId = z.uuid().describe("Model credential ID.");
const runMessage = z
  .string()
  .trim()
  .min(1)
  .max(automationUserMessageMaxLength);
const empty = z.object({});

function definedEntries<Value extends object>(value: Value): Partial<Value> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<Value>;
}

function invalid(message: string, error: z.ZodError): ManagementError {
  return new ManagementError(400, message, "invalid_request", error.issues);
}

function postgresError(error: unknown, code: string, constraint?: string): boolean {
  for (
    let current = error;
    current && typeof current === "object";
    current = (current as { cause?: unknown }).cause
  ) {
    if (
      "code" in current &&
      current.code === code &&
      (!constraint || ("constraint" in current && current.constraint === constraint))
    ) {
      return true;
    }
  }
  return false;
}

function automationSaveError(error: unknown, name: string): never {
  if (error instanceof AutomationConfigurationError) {
    throw new ManagementError(
      error.code === "automation_not_found" ? 404 : 400,
      error.message,
      error.code,
    );
  }
  if (postgresError(error, "23505", "automations_organization_name_idx")) {
    throw new ManagementError(
      409,
      `An automation named "${name}" already exists. Choose a different name.`,
      "automation_name_taken",
    );
  }
  throw error;
}

// A first tag mode change that picks its own integrations starts from only
// those, so default Vercel projects of an integration it leaves out are
// dropped too.
async function defaultTagModeOptions(
  organizationId: string,
  contextAccountIds: string[] | undefined,
) {
  const options = await listAgentOptions(organizationId);
  if (!contextAccountIds) return options;
  return {
    ...options,
    accounts: options.accounts.filter((account) =>
      contextAccountIds.includes(account.id),
    ),
  };
}

async function requireAutomation(context: ManagementContext, id: string) {
  const automation = await getAutomation(context.organizationId, id);
  if (!automation) {
    throw new ManagementError(404, "Automation not found", "automation_not_found");
  }
  return automation;
}

async function saveAutomation(
  context: ManagementContext,
  id: string | null,
  candidate: unknown,
) {
  const parsed = automationInputSchema.safeParse(candidate);
  if (!parsed.success) throw invalid("Invalid automation", parsed.error);
  const input: AutomationInput = parsed.data;
  let savedId = id;
  try {
    if (id) {
      const updated = await updateAutomation(
        context.organizationId,
        id,
        context.user.id,
        input,
      );
      if (!updated) {
        throw new ManagementError(404, "Automation not found", "automation_not_found");
      }
    } else {
      savedId = (
        await createAutomation(context.organizationId, context.user.id, input)
      ).id;
      await captureAnalyticsEvent({
        distinctId: context.user.id,
        event: "automation created",
        organizationId: context.organizationId,
        properties: {
          automation_id: savedId,
          model: input.configuration.model,
          source: context.source,
          trigger_kinds: [
            ...new Set(input.configuration.triggers.map((trigger) => trigger.kind)),
          ].join(","),
        },
      }).catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof ManagementError) throw error;
    automationSaveError(error, input.name);
  }
  return { automation: await requireAutomation(context, savedId!) };
}

async function listIntegrations(context: ManagementContext) {
  const options = await listAgentOptions(context.organizationId);
  return {
    integrations: options.accounts,
    repositories: options.repositories,
    resources: options.resources,
  };
}

function modelCatalogFailure(error: unknown): ManagementError {
  if (error instanceof ModelCatalogError) {
    return new ManagementError(
      error.authenticationFailed ? 400 : 502,
      error.message,
      error.authenticationFailed ? "model_authentication_failed" : "model_catalog_unavailable",
    );
  }
  return new ManagementError(
    502,
    "Unable to load models from the provider. Try again.",
    "model_catalog_unavailable",
  );
}

export const managementOperations: ManagementOperation[] = [
  ...integrationConnectionOperations,
  defineOperation({
    description:
      "Returns the workspace the API key belongs to, its enabled features, and the member the key acts as.",
    effect: "read",
    input: empty,
    method: "GET",
    name: "get_workspace",
    output: workspaceSchema,
    path: "/workspace",
    summary: "Get the workspace",
    tag: "Workspace",
    async run(context) {
      const [organization, capabilities] = await Promise.all([
        getOrganizationSummary(context.organizationId),
        listEnabledOrganizationCapabilities(context.organizationId),
      ]);
      if (!organization) throw new ManagementError(404, "Workspace not found");
      return {
        workspace: {
          ...organization,
          apiKeyId: context.apiKeyId,
          capabilities,
          member: {
            email: context.user.email,
            name: context.user.name,
            role: context.role,
            userId: context.user.id,
          },
        },
      };
    },
  }),
  defineOperation({
    description:
      "Lists the workspace's members and its pending invitations. Invite and remove members in the app.",
    effect: "read",
    input: empty,
    method: "GET",
    name: "list_members",
    output: membersSchema,
    path: "/members",
    summary: "List members",
    tag: "Workspace",
    run: (context) => listOrganizationMembers(context.organizationId),
  }),
  defineOperation({
    description:
      "Lists the workspace's active API keys. Create keys in the app under **Settings → API keys**.",
    effect: "read",
    input: empty,
    method: "GET",
    name: "list_api_keys",
    output: apiKeysSchema,
    path: "/api-keys",
    summary: "List API keys",
    tag: "API keys",
    run: async (context) => ({
      apiKeys: await listApiKeys(context.organizationId),
    }),
  }),
  defineOperation({
    description:
      "Revokes an API key. It stops working immediately. Admins and owners can revoke any key; members can revoke only their own.",
    effect: "destructive",
    input: z.object({ apiKeyId: z.uuid().describe("API key ID.") }),
    method: "DELETE",
    name: "revoke_api_key",
    output: z.object({ revoked: z.literal(true) }),
    path: "/api-keys/{apiKeyId}",
    summary: "Revoke an API key",
    tag: "API keys",
    async run(context, input) {
      const revoked = await revokeApiKey({
        apiKeyId: input.apiKeyId,
        organizationId: context.organizationId,
        role: context.role,
        userId: context.user.id,
      });
      if (!revoked) throw new ManagementError(404, "API key not found", "api_key_not_found");
      return { revoked: true as const };
    },
  }),
  defineOperation({
    description:
      "Lists connected integrations, the repositories they give access to, and their resources, such as Slack channels and Sentry projects. Use these IDs in automation and tag mode settings. Use list_available_integrations and start_integration_connection to connect a provider from chat.",
    effect: "read",
    input: empty,
    method: "GET",
    name: "list_integrations",
    output: integrationsSchema,
    path: "/integrations",
    summary: "List integrations",
    tag: "Integrations",
    run: listIntegrations,
  }),
  defineOperation({
    description:
      "Reloads GitHub repositories or Slack channels from the provider, then returns the same result as listing integrations. Use it after giving the GitHub App access to a new repository or creating a Slack channel.",
    effect: "write",
    input: z.object({
      provider: z.enum(["github", "slack"]).describe("The provider to reload."),
    }),
    method: "POST",
    name: "refresh_integrations",
    output: integrationsSchema,
    path: "/integrations/refresh",
    summary: "Refresh repositories or channels",
    tag: "Integrations",
    async run(context, input) {
      try {
        if (input.provider === "github") {
          await refreshGitHubRepositories(context.organizationId);
          await disableAgentsWithUnavailableRepositories(context.organizationId);
        } else {
          await refreshSlackChannelResources(context.organizationId);
        }
      } catch (error) {
        console.error(JSON.stringify({
          errorCode: error instanceof Error ? error.constructor.name : "unknown",
          event: "management_integration_refresh_failed",
          organizationId: context.organizationId,
          provider: input.provider,
        }));
        throw new ManagementError(
          502,
          `Unable to refresh ${input.provider === "github" ? "GitHub repositories" : "Slack channels"}. Try again.`,
          "integration_refresh_failed",
        );
      }
      return listIntegrations(context);
    },
  }),
  defineOperation({
    description:
      "Lists the environments of a Sentry connection, for a Sentry trigger's `excludedEnvironments`.",
    effect: "read",
    input: z.object({
      integrationAccountId: z.uuid().describe("Sentry integration account ID."),
    }),
    method: "GET",
    name: "list_sentry_environments",
    output: sentryEnvironmentsSchema,
    path: "/integrations/{integrationAccountId}/sentry-environments",
    summary: "List Sentry environments",
    tag: "Integrations",
    async run(context, input) {
      const account = await getOrganizationIntegrationAccount({
        integrationAccountId: input.integrationAccountId,
        organizationId: context.organizationId,
        provider: "sentry",
      });
      if (account?.status !== "connected") {
        throw new ManagementError(404, "Sentry connection not found", "integration_not_found");
      }
      try {
        const { credentials } = await getFreshSentryCredentials({
          accountId: input.integrationAccountId,
          organizationId: context.organizationId,
        });
        return {
          environments: await listSentryEnvironments(
            credentials.accessToken,
            getSentryOrganizationSlug(account.metadata),
          ),
        };
      } catch {
        throw new ManagementError(502, "Unable to load Sentry environments. Try again.");
      }
    },
  }),
  defineOperation({
    description: "Lists automations, most recently changed first, with each one's last run.",
    effect: "read",
    input: empty,
    method: "GET",
    name: "list_automations",
    output: automationListSchema,
    path: "/automations",
    requiresAutomations: true,
    summary: "List automations",
    tag: "Automations",
    run: async (context) => ({
      automations: await listAutomations(context.organizationId),
    }),
  }),
  defineOperation({
    description: "Returns an automation and its current configuration.",
    effect: "read",
    input: z.object({ automationId }),
    method: "GET",
    name: "get_automation",
    output: automationResponseSchema,
    path: "/automations/{automationId}",
    requiresAutomations: true,
    summary: "Get an automation",
    tag: "Automations",
    run: async (context, input) => ({
      automation: await requireAutomation(context, input.automationId),
    }),
  }),
  defineOperation({
    description:
      "Creates an automation. Get repository, integration, and resource IDs from `GET /integrations` and secret IDs from `GET /secrets`. Model settings you leave out use the defaults.",
    effect: "write",
    input: z.object({
      configuration: automationConfigurationInputSchema,
      description: z.string().trim().max(2_000).default("")
        .describe("A short description shown in the automation list."),
      enabled: z.boolean().default(true)
        .describe("Whether triggers start runs. Defaults to `true`."),
      name: z.string().trim().min(1).max(120)
        .describe("Unique within the workspace."),
    }),
    method: "POST",
    name: "create_automation",
    output: automationResponseSchema,
    path: "/automations",
    requiresAutomations: true,
    successStatus: 201,
    summary: "Create an automation",
    tag: "Automations",
    run: (context, input) =>
      saveAutomation(context, null, {
        ...input,
        configuration: {
          ...defaultAutomationModelSettings,
          ...definedEntries(input.configuration),
        },
      }),
  }),
  defineOperation({
    description:
      "Changes an automation. Send only what changes. In `configuration`, each field you send replaces the current value, and fields you leave out are kept. Changing only `enabled` turns the automation on or off without saving a new version.",
    effect: "write",
    input: z.object({
      automationId,
      configuration: automationConfigurationChangesSchema.optional(),
      description: z.string().trim().max(2_000).optional(),
      enabled: z.boolean().optional()
        .describe("Whether triggers start runs."),
      name: z.string().trim().min(1).max(120).optional(),
    }),
    method: "PATCH",
    name: "update_automation",
    output: automationResponseSchema,
    path: "/automations/{automationId}",
    requiresAutomations: true,
    summary: "Update an automation",
    tag: "Automations",
    async run(context, input) {
      const configuration = input.configuration
        ? definedEntries(input.configuration)
        : {};
      const changesConfiguration = Object.keys(configuration).length > 0;
      if (
        !changesConfiguration &&
        input.description === undefined &&
        input.name === undefined
      ) {
        if (input.enabled === undefined) {
          throw new ManagementError(400, "Nothing to change", "invalid_request");
        }
        const updated = await setAutomationEnabled({
          automationId: input.automationId,
          enabled: input.enabled,
          organizationId: context.organizationId,
        });
        if (!updated) {
          throw new ManagementError(404, "Automation not found", "automation_not_found");
        }
        return { automation: await requireAutomation(context, input.automationId) };
      }
      const current = await requireAutomation(context, input.automationId);
      return saveAutomation(context, input.automationId, {
        configuration: { ...current.configuration, ...configuration },
        description: input.description ?? current.description,
        enabled: input.enabled ?? current.enabled,
        name: input.name ?? current.name,
      });
    },
  }),
  defineOperation({
    description: "Lists an automation's runs, newest first.",
    effect: "read",
    input: z.object({
      automationId,
      page: z.coerce.number().int().min(1).max(10_000).default(1)
        .describe("Page number, starting at 1."),
      pageSize: z.coerce.number().int().min(1).max(50).default(10)
        .describe("Runs per page, up to 50."),
    }),
    method: "GET",
    name: "list_automation_runs",
    output: runListSchema,
    path: "/automations/{automationId}/runs",
    requiresAutomations: true,
    summary: "List runs",
    tag: "Runs",
    async run(context, input) {
      const runs = await listAutomationRuns(
        context.organizationId,
        input.automationId,
        { limit: input.pageSize, offset: (input.page - 1) * input.pageSize },
      );
      return { ...runs, page: input.page, pageSize: input.pageSize };
    },
  }),
  defineOperation({
    description:
      "Starts a run now. With a `message`, the run starts as a chat: the agent gets the message as its request, and you can continue with follow-up messages.",
    effect: "write",
    input: z.object({
      automationId,
      message: runMessage.optional()
        .describe("A request for the agent. Leave it out for a plain manual run."),
    }),
    method: "POST",
    name: "start_automation_run",
    output: z.object({
      duplicate: z.boolean().describe("True when an identical run was already queued."),
      runId: z.uuid().describe("Run ID."),
    }),
    path: "/automations/{automationId}/runs",
    requiresAutomations: true,
    successStatus: 202,
    summary: "Start a run",
    tag: "Runs",
    async run(context, input) {
      const automation = await requireAutomation(context, input.automationId);
      if (!automation.enabled) {
        throw new ManagementError(409, "Turn the automation on to start a run.", "automation_disabled");
      }
      const via = context.source === "mcp" ? "MCP" : "the API";
      const { user } = context;
      const title = input.message
        ? (input.message.split("\n").map((line) => line.trim()).find(Boolean) ?? "Manual run").slice(0, 80)
        : "Manual run";
      try {
        const run = await queueAutomationRun({
          automationId: automation.id,
          ...(input.message
            ? { message: { authorId: user.id, authorName: user.name, text: input.message } }
            : {}),
          trigger: {
            body: input.message ?? `Manual run requested through ${via}.`,
            externalEventId: `manual:${randomUUID()}`,
            provider: "manual",
            title,
          },
        });
        return { duplicate: run.duplicate, runId: run.runId };
      } catch (error) {
        // The automation was turned off or removed after it was read.
        if (error instanceof AutomationConfigurationError) {
          throw new ManagementError(409, "Turn the automation on to start a run.", "automation_disabled");
        }
        throw new ManagementError(503, "Automation worker is unavailable. Try again.", "worker_unavailable");
      }
    },
  }),
  defineOperation({
    description:
      "Returns a run with its status, result, usage, and transcript events.",
    effect: "read",
    input: z.object({ runId }),
    method: "GET",
    name: "get_automation_run",
    output: runResponseSchema,
    path: "/runs/{runId}",
    requiresAutomations: true,
    summary: "Get a run",
    tag: "Runs",
    async run(context, input) {
      const run = await getAutomationRun(context.organizationId, input.runId);
      if (!run) throw new ManagementError(404, "Automation run not found", "run_not_found");
      return { run };
    },
  }),
  defineOperation({
    description: "Asks an active run to stop. The run ends as `cancelled`.",
    effect: "write",
    input: z.object({ runId }),
    method: "POST",
    name: "cancel_automation_run",
    output: z.object({ cancelRequested: z.literal(true) }),
    path: "/runs/{runId}/cancel",
    requiresAutomations: true,
    summary: "Cancel a run",
    tag: "Runs",
    async run(context, input) {
      const cancelled = await requestAutomationRunCancellation({
        organizationId: context.organizationId,
        runId: input.runId,
      });
      if (!cancelled) {
        throw new ManagementError(409, "Automation run is not active", "run_not_active");
      }
      return { cancelRequested: true as const };
    },
  }),
  defineOperation({
    description:
      "Sends a follow-up message to a finished run. The agent continues the same conversation in a new turn.",
    effect: "write",
    input: z.object({
      message: runMessage.describe("The follow-up message."),
      runId,
    }),
    method: "POST",
    name: "send_automation_run_message",
    output: z.object({ queued: z.literal(true) }),
    path: "/runs/{runId}/messages",
    requiresAutomations: true,
    successStatus: 202,
    summary: "Send a follow-up message",
    tag: "Runs",
    async run(context, input) {
      const { organizationId, user } = context;
      let queued: { jobId: string } | null;
      try {
        queued = await queueAutomationRunFollowUp({
          message: { authorId: user.id, authorName: user.name, text: input.message },
          organizationId,
          runId: input.runId,
        });
      } catch {
        throw new ManagementError(503, "Automation worker is unavailable. Try again.", "worker_unavailable");
      }
      if (queued) return { queued: true as const };
      const run = await getAutomationRun(organizationId, input.runId);
      if (!run) throw new ManagementError(404, "Automation run not found", "run_not_found");
      throw new ManagementError(
        409,
        run.automationEnabled
          ? "Wait for this run to finish before sending a follow-up."
          : "Turn the automation on to continue this run.",
        run.automationEnabled ? "run_active" : "automation_disabled",
      );
    },
  }),
  defineOperation({
    description:
      "Returns tag mode settings: whether Slack mentions get answers, the prompt, and the repositories, integrations, and secrets it can use. Null when tag mode has never been set up.",
    effect: "read",
    input: empty,
    method: "GET",
    name: "get_tag_mode",
    output: tagModeResponseSchema,
    path: "/tag-mode",
    summary: "Get tag mode",
    tag: "Tag mode",
    run: async (context) => ({
      tagMode: await getSlackThreadModeConfiguration(context.organizationId),
    }),
  }),
  defineOperation({
    description:
      "Changes tag mode. Send only what changes; each list you send replaces the current selection. The first change starts from every connected context integration. Tag mode needs a Slack connection.",
    effect: "write",
    input: tagModeChangesSchema,
    method: "PATCH",
    name: "update_tag_mode",
    output: tagModeResponseSchema,
    path: "/tag-mode",
    summary: "Update tag mode",
    tag: "Tag mode",
    async run(context, input) {
      const changes = definedEntries(input);
      if (Object.keys(changes).length === 0) {
        throw new ManagementError(400, "Nothing to change", "invalid_request");
      }
      const [current, capabilities] = await Promise.all([
        getSlackThreadModeConfiguration(context.organizationId),
        listEnabledOrganizationCapabilities(context.organizationId),
      ]);
      const parsed = slackThreadModeConfigurationSchema.safeParse({
        ...(current ?? defaultSlackThreadModeConfiguration({
          instructions: capabilities.includes("simplified_navigation")
            ? tagModeAssistantInstructions
            : tagModeInvestigationInstructions,
          options: await defaultTagModeOptions(
            context.organizationId,
            changes.contextAccountIds,
          ),
        })),
        ...changes,
      });
      if (!parsed.success) throw invalid("Invalid tag mode settings", parsed.error);
      try {
        await saveSlackThreadModeConfiguration({
          configuration: parsed.data,
          organizationId: context.organizationId,
          userId: context.user.id,
        });
      } catch (error) {
        if (error instanceof AgentConfigurationError) {
          throw new ManagementError(
            error.code === "agent_not_found" ? 404 : 400,
            error.message,
            error.code,
          );
        }
        throw error;
      }
      return { tagMode: parsed.data };
    },
  }),
  defineOperation({
    description:
      "Lists the models of one provider that automations can use with the usage included in your plan.",
    effect: "read",
    input: z.object({
      provider: automationModelProviderSchema.describe("The model provider."),
    }),
    method: "GET",
    name: "list_included_models",
    output: modelListSchema,
    path: "/models",
    requiresAutomations: true,
    summary: "List included models",
    tag: "Models",
    async run(_context, input) {
      try {
        return { models: await listAIGatewayModels(input.provider) };
      } catch (error) {
        throw modelCatalogFailure(error);
      }
    },
  }),
  defineOperation({
    description:
      "Lists the workspace's model API keys and ChatGPT subscriptions. Key values are never returned.",
    effect: "read",
    input: empty,
    method: "GET",
    name: "list_model_credentials",
    output: modelCredentialListSchema,
    path: "/model-credentials",
    requiresAutomations: true,
    summary: "List model credentials",
    tag: "Models",
    run: async (context) => ({
      modelCredentials: await listOrganizationModelCredentials(context.organizationId),
    }),
  }),
  defineOperation({
    description:
      "Adds a model provider API key. Superlog checks the key with the provider before saving it. Every automation that uses this provider then runs on your key. Connect a ChatGPT subscription in the app.",
    effect: "write",
    input: z.object({
      apiKey: z.string().min(1).max(4_096).describe("The provider API key."),
      label: z.string().trim().min(1).max(120).describe("A name for the key, unique within the workspace."),
      provider: automationModelProviderSchema,
    }),
    mcp: false,
    method: "POST",
    name: "create_model_credential",
    output: modelCredentialResponseSchema,
    path: "/model-credentials",
    requiresAutomations: true,
    successStatus: 201,
    summary: "Add a model API key",
    tag: "Models",
    async run(context, input) {
      try {
        await listProviderModels(input.provider, input.apiKey);
      } catch (error) {
        throw modelCatalogFailure(error);
      }
      let created: { id: string };
      try {
        created = await createOrganizationModelCredential({
          ...input,
          organizationId: context.organizationId,
        });
      } catch (error) {
        if (postgresError(error, "23505", "organization_model_credentials_label_idx")) {
          throw new ManagementError(409, `A model credential labeled "${input.label}" already exists.`, "label_taken");
        }
        throw error;
      }
      const credentials = await listOrganizationModelCredentials(context.organizationId);
      const credential = credentials.find((item) => item.id === created.id);
      if (!credential) throw new Error("Model credential was not saved");
      return { modelCredential: credential };
    },
  }),
  defineOperation({
    description: "Replaces the key of a model API key credential, for example after you rotate it with the provider.",
    effect: "write",
    input: z.object({
      apiKey: z.string().min(1).max(4_096).describe("The new provider API key."),
      credentialId,
    }),
    mcp: false,
    method: "POST",
    name: "rotate_model_credential",
    output: z.object({ rotated: z.literal(true) }),
    path: "/model-credentials/{credentialId}/rotate",
    requiresAutomations: true,
    summary: "Replace a model API key",
    tag: "Models",
    async run(context, input) {
      const rotated = await rotateOrganizationModelCredential({
        apiKey: input.apiKey,
        credentialId: input.credentialId,
        organizationId: context.organizationId,
      });
      if (!rotated) throw new ManagementError(404, "Model credential not found", "credential_not_found");
      return { rotated: true as const };
    },
  }),
  defineOperation({
    description:
      "Checks that a model credential works and can use a model. The credential's status is updated with the result.",
    effect: "write",
    input: z.object({
      credentialId,
      model: z.string().trim().min(1).max(255).describe("A model ID to check, such as `gpt-5.4`."),
    }),
    method: "POST",
    name: "test_model_credential",
    output: z.object({
      authenticationFailed: z.boolean().describe("True when the provider rejected the key."),
      valid: z.boolean().describe("True when the key works and can use the model."),
    }),
    path: "/model-credentials/{credentialId}/test",
    requiresAutomations: true,
    summary: "Test a model credential",
    tag: "Models",
    async run(context, input) {
      const credential = await getOrganizationModelCredentialForValidation({
        credentialId: input.credentialId,
        organizationId: context.organizationId,
      });
      if (!credential) throw new ManagementError(404, "Model credential not found", "credential_not_found");
      let result: { authenticationFailed: boolean; valid: boolean };
      try {
        const models = await listProviderModels(credential.provider, credential.apiKey);
        result = {
          authenticationFailed: false,
          valid: models.some((model) => model.id === input.model),
        };
      } catch (error) {
        if (!(error instanceof ModelCatalogError && error.authenticationFailed)) {
          throw new ManagementError(503, "Model provider is temporarily unavailable", "model_catalog_unavailable");
        }
        result = { authenticationFailed: true, valid: false };
      }
      if (result.valid || result.authenticationFailed) {
        await markOrganizationModelCredentialValidated({
          credentialId: input.credentialId,
          encryptedCredentials: credential.encryptedCredentials,
          organizationId: context.organizationId,
          valid: result.valid,
        });
      }
      return result;
    },
  }),
  defineOperation({
    description: "Lists the models a model credential can use.",
    effect: "read",
    input: z.object({
      credentialId,
      refresh: z.enum(["true", "false"]).default("false")
        .describe("For a ChatGPT subscription, `true` reloads the list instead of using the cached one."),
    }),
    method: "GET",
    name: "list_model_credential_models",
    output: modelListSchema,
    path: "/model-credentials/{credentialId}/models",
    requiresAutomations: true,
    summary: "List a credential's models",
    tag: "Models",
    async run(context, input) {
      const credential = await getOrganizationModelCredential({
        credentialId: input.credentialId,
        organizationId: context.organizationId,
      });
      if (!credential) throw new ManagementError(404, "Model credential not found", "credential_not_found");
      try {
        return {
          models: credential.subscription
            ? await listSubscriptionModels(
                { credentialId: input.credentialId, organizationId: context.organizationId },
                input.refresh === "true",
              )
            : await listProviderModels(credential.provider, credential.apiKey),
        };
      } catch (error) {
        throw modelCatalogFailure(error);
      }
    },
  }),
  defineOperation({
    description:
      "Removes a model credential. Automations that used it fall back to included usage.",
    effect: "destructive",
    input: z.object({ credentialId }),
    method: "DELETE",
    name: "delete_model_credential",
    output: z.object({ deleted: z.literal(true) }),
    path: "/model-credentials/{credentialId}",
    requiresAutomations: true,
    summary: "Remove a model credential",
    tag: "Models",
    async run(context, input) {
      let deleted: boolean;
      try {
        deleted = await deleteOrganizationModelCredential({
          credentialId: input.credentialId,
          organizationId: context.organizationId,
        });
      } catch (error) {
        if (postgresError(error, "23503")) {
          throw new ManagementError(409, "Model credential is in use", "credential_in_use");
        }
        throw error;
      }
      if (!deleted) throw new ManagementError(404, "Model credential not found", "credential_not_found");
      return { deleted: true as const };
    },
  }),
  defineOperation({
    description: "Lists workspace secrets. Secret values are never returned.",
    effect: "read",
    input: empty,
    method: "GET",
    name: "list_secrets",
    output: secretListSchema,
    path: "/secrets",
    summary: "List workspace secrets",
    tag: "Secrets",
    run: async (context) => ({
      secrets: await listWorkspaceSecrets(context.organizationId),
    }),
  }),
  defineOperation({
    description:
      "Stores a workspace secret. Agents see the environment variable `name` with a placeholder value, and Superlog substitutes the real value only in requests to the allowed hosts. The value cannot be read back.",
    effect: "write",
    input: workspaceSecretInputSchema.extend({
      allowedHosts: workspaceSecretInputSchema.shape.allowedHosts
        .describe("1 to 20 hostnames without a scheme, path, or port. A leading `*.` matches subdomains."),
      name: workspaceSecretInputSchema.shape.name
        .describe("The environment variable name, such as `METRICS_API_KEY`."),
      value: workspaceSecretInputSchema.shape.value.describe("The secret value, up to 64 KB."),
    }),
    mcp: false,
    method: "POST",
    name: "create_secret",
    output: secretResponseSchema,
    path: "/secrets",
    successStatus: 201,
    summary: "Create a workspace secret",
    tag: "Secrets",
    async run(context, input) {
      const stored = await storeWorkspaceSecret({
        organizationId: context.organizationId,
        secret: input,
        userId: context.user.id,
      });
      if (!stored.ok) {
        throw new ManagementError(
          stored.status,
          stored.error,
          stored.status === 409 ? "secret_name_taken" : "secret_storage_failed",
        );
      }
      return { secret: stored.secret };
    },
  }),
];
