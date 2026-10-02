import { tool } from "@openai/agents";
import {
  slackThreadModeConfigurationSchema,
  type SlackThreadModeConfiguration,
} from "@responder/core/agents/config";
import { captureAnalyticsEvent } from "@responder/core/analytics";
import {
  automationConfigurationSchema,
  automationInputSchema,
  defaultAutomationModelSettings,
} from "@responder/core/automations/config";
import {
  getSlackThreadModeConfiguration,
  listAgentOptions,
  saveSlackThreadModeConfiguration,
} from "@responder/core/db/agents";
import {
  createAutomation,
  getAutomation,
  listAutomations,
  setAutomationEnabled,
  updateAutomation,
} from "@responder/core/db/automations";
import { z } from "zod";
import type { AutomationToolResult } from "./automation-tools.js";

// More resources than this are left out of get_workspace.
const maxListedResources = 1_000;

export interface WorkspaceToolDependencies {
  captureEvent: typeof captureAnalyticsEvent;
  createAutomation: typeof createAutomation;
  getAutomation: typeof getAutomation;
  getTagMode: typeof getSlackThreadModeConfiguration;
  listAgentOptions: typeof listAgentOptions;
  listAutomations: typeof listAutomations;
  saveTagMode: typeof saveSlackThreadModeConfiguration;
  setAutomationEnabled: typeof setAutomationEnabled;
  updateAutomation: typeof updateAutomation;
}

const defaultDependencies: WorkspaceToolDependencies = {
  captureEvent: captureAnalyticsEvent,
  createAutomation,
  getAutomation,
  getTagMode: getSlackThreadModeConfiguration,
  listAgentOptions,
  listAutomations,
  saveTagMode: saveSlackThreadModeConfiguration,
  setAutomationEnabled,
  updateAutomation,
};

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be a JSON object`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
    .join("; ");
}

// One workspace tool, served to Slack threads as an agent tool and to
// automation runs through the sandbox tool server.
export interface WorkspaceTool {
  description: string;
  execute(args: unknown): Promise<unknown>;
  name: string;
  parameters: z.ZodObject;
  readOnly: boolean;
}

function workspaceTool<T extends z.ZodObject>(spec: {
  description: string;
  execute(args: z.infer<T>): unknown;
  name: string;
  parameters: T;
  readOnly: boolean;
}): WorkspaceTool {
  return {
    ...spec,
    execute: async (args) => spec.execute(spec.parameters.parse(args)),
  };
}

// Postgres reports a duplicate automation name on the error's cause.
function nameConflict(error: unknown): boolean {
  for (let current = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
    if ("constraint" in current && current.constraint === "automations_organization_name_idx") {
      return true;
    }
  }
  return false;
}

export interface WorkspaceToolInput {
  // The member changes are saved as: getSlackThreadModeActor for a Slack
  // thread, getAutomationRunActor for an automation run.
  actorUserId: string | null;
  automationsEnabled: boolean;
  integrationsUrl: string;
  organizationId: string;
  source: "automation_run" | "slack_thread";
}

// Tools that read and change the workspace: automations, tag mode, and the
// integrations each of them uses.
export function workspaceToolSpecs(
  input: WorkspaceToolInput,
  dependencies: WorkspaceToolDependencies = defaultDependencies,
): WorkspaceTool[] {
  const { organizationId } = input;
  const actor = () => {
    if (!input.actorUserId) {
      throw new Error("No workspace member can be recorded for this change. Ask a workspace owner to make it in Responder.");
    }
    return input.actorUserId;
  };
  const requireAutomations = () => {
    if (!input.automationsEnabled) {
      throw new Error("Automations are not available in this workspace.");
    }
  };

  async function saveAutomation(
    automationId: string | null,
    candidate: Record<string, unknown>,
  ) {
    const parsed = automationInputSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(`Invalid automation: ${validationMessage(parsed.error)}`);
    }
    try {
      if (automationId) {
        const updated = await dependencies.updateAutomation(
          organizationId,
          automationId,
          actor(),
          parsed.data,
        );
        if (!updated) throw new Error("Automation not found");
        return { automationId, updated: true };
      }
      const created = await dependencies.createAutomation(
        organizationId,
        actor(),
        parsed.data,
      );
      await dependencies.captureEvent({
        distinctId: actor(),
        event: "automation created",
        organizationId,
        properties: {
          automation_id: created.id,
          model: parsed.data.configuration.model,
          source: input.source,
          trigger_kinds: [...new Set(parsed.data.configuration.triggers.map((trigger) => trigger.kind))].join(","),
        },
      }).catch(() => undefined);
      return { automationId: created.id, created: true };
    } catch (error) {
      if (nameConflict(error)) {
        throw new Error(`An automation named "${parsed.data.name}" already exists. Choose a different name.`);
      }
      throw error;
    }
  }

  const getWorkspace = workspaceTool({
    name: "get_workspace",
    readOnly: true,
    description:
      "Read this workspace's automations, tag mode settings, connected integrations, repositories, integration resources (such as Slack channels and Sentry projects), and workspace secret names. Use the returned IDs when changing automations or tag mode.",
    parameters: z.object({}),
    async execute() {
      const [automations, tagMode, options] = await Promise.all([
        input.automationsEnabled
          ? dependencies.listAutomations(organizationId)
          : Promise.resolve(null),
        dependencies.getTagMode(organizationId),
        dependencies.listAgentOptions(organizationId),
      ]);
      return {
        automations: automations?.map((automation) => ({
          description: automation.description,
          enabled: automation.enabled,
          id: automation.id,
          name: automation.name,
          triggers: automation.triggers,
        })) ?? "Automations are not available in this workspace.",
        integrations: options.accounts.map((account) => ({
          displayName: account.displayName,
          id: account.id,
          provider: account.provider,
        })),
        integrationsUrl: input.integrationsUrl,
        repositories: options.repositories.map((repository) => ({
          defaultBranch: repository.defaultBranch,
          fullName: repository.fullName,
          id: repository.id,
        })),
        resources: options.resources.slice(0, maxListedResources).map((resource) => ({
          displayName: resource.displayName,
          externalId: resource.externalId,
          id: resource.id,
          integrationAccountId: resource.integrationAccountId,
          kind: resource.kind,
        })),
        ...(options.resources.length > maxListedResources
          ? { resourcesTruncated: options.resources.length - maxListedResources }
          : {}),
        secrets: options.secrets.map((secret) => ({
          allowedHosts: secret.allowedHosts,
          id: secret.id,
          name: secret.name,
        })),
        tagMode,
      };
    },
  });

  const getAutomationTool = workspaceTool({
    name: "get_automation",
    readOnly: true,
    description: "Read one automation's full configuration.",
    parameters: z.object({ automationId: z.uuid() }),
    async execute({ automationId }) {
      requireAutomations();
      const automation = await dependencies.getAutomation(organizationId, automationId);
      if (!automation) throw new Error("Automation not found");
      return {
        configuration: automation.configuration,
        description: automation.description,
        enabled: automation.enabled,
        id: automation.id,
        name: automation.name,
        updatedAt: automation.updatedAt,
        version: automation.version,
      };
    },
  });

  const getConfigurationSchema = workspaceTool({
    name: "get_automation_configuration_schema",
    readOnly: true,
    description:
      "Return the JSON schema of an automation configuration and the model settings a new automation starts with. Read it before creating an automation or changing its triggers.",
    parameters: z.object({}),
    execute() {
      requireAutomations();
      return {
        defaults: defaultAutomationModelSettings,
        schema: z.toJSONSchema(automationConfigurationSchema, {
          io: "input",
          unrepresentable: "any",
        }),
      };
    },
  });

  const createAutomationTool = workspaceTool({
    name: "create_automation",
    readOnly: false,
    description:
      "Create an automation. configuration is a JSON object matching get_automation_configuration_schema; omitted model settings use its defaults.",
    parameters: z.object({
      configuration: z.string().min(2).max(100_000)
        .describe("The automation configuration as a JSON object."),
      description: z.string().max(2_000).nullable(),
      enabled: z.boolean(),
      name: z.string().trim().min(1).max(120),
    }),
    async execute(request) {
      requireAutomations();
      return saveAutomation(null, {
        configuration: {
          ...defaultAutomationModelSettings,
          ...parseJsonObject(request.configuration, "configuration"),
        },
        description: request.description ?? "",
        enabled: request.enabled,
        name: request.name,
      });
    },
  });

  const updateAutomationTool = workspaceTool({
    name: "update_automation",
    readOnly: false,
    description:
      "Change an automation. Pass only what changes; null keeps the current value. configuration is a JSON object whose top-level fields replace the current ones.",
    parameters: z.object({
      automationId: z.uuid(),
      configuration: z.string().min(2).max(100_000).nullable()
        .describe("Configuration fields to replace, as a JSON object."),
      description: z.string().max(2_000).nullable(),
      enabled: z.boolean().nullable(),
      name: z.string().trim().min(1).max(120).nullable(),
    }),
    async execute(request) {
      requireAutomations();
      if (
        request.configuration === null &&
        request.description === null &&
        request.name === null
      ) {
        if (request.enabled === null) throw new Error("Nothing to change");
        const updated = await dependencies.setAutomationEnabled({
          automationId: request.automationId,
          enabled: request.enabled,
          organizationId,
        });
        if (!updated) throw new Error("Automation not found");
        return { automationId: request.automationId, enabled: request.enabled };
      }
      const current = await dependencies.getAutomation(organizationId, request.automationId);
      if (!current) throw new Error("Automation not found");
      return saveAutomation(request.automationId, {
        configuration: {
          ...current.configuration,
          ...(request.configuration
            ? parseJsonObject(request.configuration, "configuration")
            : {}),
        },
        description: request.description ?? current.description,
        enabled: request.enabled ?? current.enabled,
        name: request.name ?? current.name,
      });
    },
  });

  const updateTagMode = workspaceTool({
    name: "update_tag_mode",
    readOnly: false,
    description:
      "Change tag mode, which answers when Responder is mentioned in Slack. Pass only what changes; null keeps the current value. Lists replace the current selection. Context accounts are integration IDs; context resources are resource IDs, such as Vercel projects.",
    parameters: z.object({
      contextAccountIds: z.array(z.uuid()).max(20).nullable(),
      contextResourceIds: z.array(z.uuid()).max(100).nullable(),
      enabled: z.boolean().nullable(),
      instructions: z.string().trim().min(1).nullable()
        .describe("The custom prompt added to every tag mode request."),
      repositoryIds: z.array(z.uuid()).max(100).nullable(),
      secretIds: z.array(z.uuid()).max(20).nullable(),
    }),
    async execute(request) {
      const current = await dependencies.getTagMode(organizationId);
      if (!current) throw new Error("Tag mode is not set up in this workspace");
      const changes = Object.fromEntries(
        Object.entries(request).filter(([, value]) => value !== null),
      ) as Partial<SlackThreadModeConfiguration>;
      if (Object.keys(changes).length === 0) throw new Error("Nothing to change");
      const parsed = slackThreadModeConfigurationSchema.safeParse({ ...current, ...changes });
      if (!parsed.success) {
        throw new Error(`Invalid tag mode settings: ${validationMessage(parsed.error)}`);
      }
      await dependencies.saveTagMode({
        configuration: parsed.data,
        organizationId,
        userId: actor(),
      });
      return { changed: Object.keys(changes), tagMode: parsed.data };
    },
  });

  return [
    getWorkspace,
    getAutomationTool,
    getConfigurationSchema,
    createAutomationTool,
    updateAutomationTool,
    updateTagMode,
  ];
}

// The workspace tools as agent tools for a Slack thread.
export function createWorkspaceTools(
  input: Omit<WorkspaceToolInput, "source">,
  dependencies: WorkspaceToolDependencies = defaultDependencies,
) {
  return workspaceToolSpecs({ ...input, source: "slack_thread" }, dependencies).map((spec) =>
    tool({
      description: spec.description,
      execute: (args) => spec.execute(args),
      name: spec.name,
      parameters: spec.parameters,
    }));
}

// The workspace tools as MCP tool definitions for the sandbox tool server.
export function workspaceToolDefinitions(specs: WorkspaceTool[]) {
  return specs.map((spec) => {
    const inputSchema: Record<string, unknown> = z.toJSONSchema(spec.parameters, { io: "input" });
    delete inputSchema.$schema;
    return {
      annotations: {
        destructiveHint: false,
        openWorldHint: false,
        readOnlyHint: spec.readOnly,
      },
      description: spec.description,
      inputSchema,
      name: spec.name,
    };
  });
}

// Answers an automation run's call to a workspace tool. Harnesses can leave
// out a field that may be null, so a missing field is read as null.
export async function callWorkspaceTool(
  spec: WorkspaceTool,
  args: unknown,
): Promise<AutomationToolResult> {
  const provided = args && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
  const filled = Object.fromEntries(
    Object.entries(spec.parameters.shape).map(([key, schema]) => [
      key,
      key in provided || !schema.safeParse(null).success ? provided[key] : null,
    ]),
  );
  try {
    const result = await spec.execute(filled);
    return { content: [{ text: JSON.stringify(result), type: "text" }] };
  } catch (error) {
    const message = error instanceof z.ZodError
      ? `Invalid tool arguments: ${validationMessage(error)}`
      : error instanceof Error
        ? error.message.slice(0, 2_000)
        : "The tool failed";
    return { content: [{ text: message, type: "text" }], isError: true };
  }
}
