import { tool } from "@openai/agents";
import {
  automationConfigurationSchema,
  defaultAutomationModelSettings,
} from "@responder/core/automations/config";
import {
  getSlackThreadModeConfiguration,
  listAgentOptions,
} from "@responder/core/db/agents";
import { getAutomation, listAutomations } from "@responder/core/db/automations";
import { z } from "zod";
import type { AutomationToolResult } from "./automation-tools.js";

// More resources than this are left out of get_workspace.
const maxListedResources = 1_000;

export interface WorkspaceToolDependencies {
  getAutomation: typeof getAutomation;
  getTagMode: typeof getSlackThreadModeConfiguration;
  listAgentOptions: typeof listAgentOptions;
  listAutomations: typeof listAutomations;
}

const defaultDependencies: WorkspaceToolDependencies = {
  getAutomation,
  getTagMode: getSlackThreadModeConfiguration,
  listAgentOptions,
  listAutomations,
};

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

export function workspaceTool<T extends z.ZodObject>(spec: {
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

export interface WorkspaceToolInput {
  automationsEnabled: boolean;
  integrationsUrl: string;
  organizationId: string;
}

// Tools that read the workspace: automations, tag mode, and the integrations
// each of them uses. Agents get no tool that changes automations or tag mode,
// because what they read, such as an alert or a log line, could ask them to
// rewrite their own instructions. Members make those changes in Responder.
export function workspaceToolSpecs(
  input: WorkspaceToolInput,
  dependencies: WorkspaceToolDependencies = defaultDependencies,
): WorkspaceTool[] {
  const { organizationId } = input;
  const requireAutomations = () => {
    if (!input.automationsEnabled) {
      throw new Error("Automations are not available in this workspace.");
    }
  };

  const getWorkspace = workspaceTool({
    name: "get_workspace",
    readOnly: true,
    description:
      "Read this workspace's automations, tag mode settings, connected integrations, repositories, integration resources (such as Slack channels and Sentry projects), and workspace secret names.",
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
      "Return the JSON schema of an automation configuration and the model settings a new automation starts with, to explain what an automation can do.",
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

  return [getWorkspace, getAutomationTool, getConfigurationSchema];
}

// The workspace tools as agent tools for a Slack thread.
export function createWorkspaceTools(
  input: WorkspaceToolInput,
  dependencies: WorkspaceToolDependencies = defaultDependencies,
) {
  return workspaceToolSpecs(input, dependencies).map((spec) =>
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
