import { describe, expect, it, vi } from "vitest";
import {
  callWorkspaceTool,
  createWorkspaceTools,
  workspaceToolDefinitions,
  workspaceToolSpecs,
  type WorkspaceToolDependencies,
} from "./workspace-tools.js";

const ids = {
  automation: "10000000-0000-4000-8000-000000000001",
  repository: "10000000-0000-4000-8000-000000000002",
  sentry: "10000000-0000-4000-8000-000000000003",
};

const tagMode = {
  contextAccountIds: [],
  contextResourceIds: [],
  enabled: true,
  instructions: "Keep replies short.",
  model: "instance/default",
  repositoryIds: [],
  secretIds: [],
};

const automationConfiguration = {
  contextAccountIds: [],
  harness: "codex" as const,
  maxModelRequests: 500,
  maxOutputTokensPerRequest: 16_000,
  maxRuntimeSeconds: 1_800,
  model: "gpt-5.4",
  modelProvider: "openai" as const,
  notifications: [],
  prompt: "Summarize yesterday's errors.",
  repositoryIds: [ids.repository],
  toolPolicy: "full" as const,
  triggers: [{ frequency: "daily" as const, hour: 9, kind: "schedule" as const, timezone: "UTC", weekday: 1 }],
  workspaceSecretIds: [],
};

function toolDependencies() {
  return {
    getAutomation: vi.fn().mockResolvedValue({
      configuration: automationConfiguration,
      description: "",
      enabled: true,
      id: ids.automation,
      name: "Daily errors",
      runs: [],
      updatedAt: new Date(0),
      version: 1,
      versionId: "version-1",
    }),
    getTagMode: vi.fn().mockResolvedValue(tagMode),
    listAgentOptions: vi.fn().mockResolvedValue({
      accounts: [{ displayName: "Acme", id: ids.sentry, provider: "sentry", slackContextAvailable: false }],
      repositories: [{ defaultBranch: "main", fullName: "acme/api", id: ids.repository, integrationAccountId: "github", private: true }],
      resources: [],
      secrets: [],
    }),
    listAutomations: vi.fn().mockResolvedValue([]),
  };
}

function workspaceTools(input: { automationsEnabled?: boolean } = {}) {
  const dependencies = toolDependencies();
  const tools = createWorkspaceTools({
    automationsEnabled: input.automationsEnabled ?? true,
    integrationsUrl: "https://app.example.com/settings",
    organizationId: "organization-1",
  }, dependencies as unknown as WorkspaceToolDependencies);
  const call = (name: string, args: unknown = {}) =>
    tools.find((tool) => tool.name === name)!.invoke(undefined as never, JSON.stringify(args));
  return { call, dependencies };
}

describe("Slack workspace tools", () => {
  it("lists the workspace with its IDs", async () => {
    const { call } = workspaceTools();

    await expect(call("get_workspace")).resolves.toMatchObject({
      automations: [],
      integrations: [{ id: ids.sentry, provider: "sentry" }],
      integrationsUrl: "https://app.example.com/settings",
      repositories: [{ fullName: "acme/api", id: ids.repository }],
      tagMode,
    });
  });

  it("describes the automation configuration as a JSON schema", async () => {
    const { call } = workspaceTools();

    await expect(call("get_automation_configuration_schema")).resolves.toMatchObject({
      defaults: { harness: "codex", model: "gpt-5.4" },
      schema: { properties: { prompt: { type: "string" }, triggers: { type: "array" } } },
    });
  });

  it("offers no tool that changes the workspace", () => {
    const tools = createWorkspaceTools({
      automationsEnabled: true,
      integrationsUrl: "https://app.example.com/settings",
      organizationId: "organization-1",
    }, toolDependencies() as unknown as WorkspaceToolDependencies);

    expect(tools.map((tool) => tool.name)).toEqual([
      "get_workspace",
      "get_automation",
      "get_automation_configuration_schema",
    ]);
  });

  it("refuses automation changes in a workspace without automations", async () => {
    const { call, dependencies } = workspaceTools({ automationsEnabled: false });

    await expect(call("get_workspace")).resolves.toMatchObject({
      automations: "Automations are not available in this workspace.",
    });
    await expect(call("get_automation", { automationId: ids.automation }))
      .resolves.toContain("Automations are not available");
    expect(dependencies.getAutomation).not.toHaveBeenCalled();
  });
});

describe("automation run workspace tools", () => {
  function automationRunTools() {
    const dependencies = toolDependencies();
    const specs = workspaceToolSpecs({
      automationsEnabled: true,
      integrationsUrl: "https://app.example.com/settings",
      organizationId: "organization-1",
    }, dependencies as unknown as WorkspaceToolDependencies);
    const call = (name: string, args: unknown) =>
      callWorkspaceTool(specs.find((spec) => spec.name === name)!, args);
    return { call, dependencies, specs };
  }

  it("describes each tool for the sandbox tool server as read-only", () => {
    const definitions = workspaceToolDefinitions(automationRunTools().specs);

    expect(definitions.map((definition) => definition.name)).toEqual([
      "get_workspace",
      "get_automation",
      "get_automation_configuration_schema",
    ]);
    for (const definition of definitions) {
      expect(definition).toMatchObject({ annotations: { readOnlyHint: true } });
      expect(definition.inputSchema).not.toHaveProperty("$schema");
    }
  });

  it("returns invalid arguments and failures as tool errors", async () => {
    const { call, dependencies } = automationRunTools();
    dependencies.getAutomation.mockResolvedValue(null);

    await expect(call("get_automation", { automationId: "not-a-uuid" })).resolves.toMatchObject({
      content: [{ text: expect.stringContaining("Invalid tool arguments: automationId") }],
      isError: true,
    });
    await expect(call("get_automation", { automationId: ids.automation })).resolves.toEqual({
      content: [{ text: "Automation not found", type: "text" }],
      isError: true,
    });
  });
});
