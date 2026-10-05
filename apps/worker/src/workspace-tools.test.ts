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
    captureEvent: vi.fn().mockResolvedValue(undefined),
    createAutomation: vi.fn().mockResolvedValue({ id: ids.automation }),
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
    saveTagMode: vi.fn().mockResolvedValue(undefined),
    setAutomationEnabled: vi.fn().mockResolvedValue(true),
    updateAutomation: vi.fn().mockResolvedValue(true),
  };
}

function workspaceTools(input: {
  actorUserId?: string | null;
  automationsEnabled?: boolean;
} = {}) {
  const dependencies = toolDependencies();
  const tools = createWorkspaceTools({
    actorUserId: input.actorUserId === undefined ? "user-1" : input.actorUserId,
    automationsEnabled: input.automationsEnabled ?? true,
    integrationsUrl: "https://app.example.com/settings",
    organizationId: "organization-1",
  }, dependencies as unknown as WorkspaceToolDependencies);
  const call = (name: string, args: unknown = {}) =>
    tools.find((tool) => tool.name === name)!.invoke(undefined as never, JSON.stringify(args));
  return { call, dependencies };
}

describe("Slack workspace tools", () => {
  it("lists the workspace with the IDs changes need", async () => {
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

  it("creates an automation with the default model settings as the tag mode owner", async () => {
    const { call, dependencies } = workspaceTools();

    await expect(call("create_automation", {
      configuration: JSON.stringify({
        prompt: "Summarize yesterday's errors.",
        repositoryIds: [ids.repository],
        triggers: automationConfiguration.triggers,
      }),
      description: null,
      enabled: true,
      name: "Daily errors",
    })).resolves.toMatchObject({ automationId: ids.automation, created: true });
    expect(dependencies.createAutomation).toHaveBeenCalledWith(
      "organization-1",
      "user-1",
      expect.objectContaining({
        configuration: expect.objectContaining({ harness: "codex", model: "gpt-5.4" }),
        name: "Daily errors",
      }),
    );
  });

  it("reports what is invalid instead of saving an automation", async () => {
    const { call, dependencies } = workspaceTools();

    await expect(call("create_automation", {
      configuration: JSON.stringify({ prompt: "Do things." }),
      description: null,
      enabled: true,
      name: "Incomplete",
    })).resolves.toContain("Invalid automation: configuration.triggers");
    expect(dependencies.createAutomation).not.toHaveBeenCalled();
  });

  it("keeps unchanged automation fields and replaces only the given configuration fields", async () => {
    const { call, dependencies } = workspaceTools();

    await call("update_automation", {
      automationId: ids.automation,
      configuration: JSON.stringify({ prompt: "Summarize today's errors." }),
      description: null,
      enabled: null,
      name: null,
    });
    expect(dependencies.updateAutomation).toHaveBeenCalledWith(
      "organization-1",
      ids.automation,
      "user-1",
      expect.objectContaining({
        configuration: expect.objectContaining({
          prompt: "Summarize today's errors.",
          repositoryIds: [ids.repository],
        }),
        name: "Daily errors",
      }),
    );
  });

  it("turns an automation off without saving a new version", async () => {
    const { call, dependencies } = workspaceTools();

    await call("update_automation", {
      automationId: ids.automation,
      configuration: null,
      description: null,
      enabled: false,
      name: null,
    });
    expect(dependencies.setAutomationEnabled).toHaveBeenCalledWith({
      automationId: ids.automation,
      enabled: false,
      organizationId: "organization-1",
    });
    expect(dependencies.updateAutomation).not.toHaveBeenCalled();
  });

  it("changes only the given tag mode settings", async () => {
    const { call, dependencies } = workspaceTools();

    await call("update_tag_mode", {
      contextAccountIds: [ids.sentry],
      contextResourceIds: null,
      enabled: null,
      instructions: null,
      repositoryIds: null,
      secretIds: null,
    });
    expect(dependencies.saveTagMode).toHaveBeenCalledWith({
      configuration: { ...tagMode, contextAccountIds: [ids.sentry] },
      organizationId: "organization-1",
      userId: "user-1",
    });
  });

  it("refuses changes when no workspace member can be recorded", async () => {
    const { call, dependencies } = workspaceTools({ actorUserId: null });

    await expect(call("update_tag_mode", {
      contextAccountIds: null,
      contextResourceIds: null,
      enabled: false,
      instructions: null,
      repositoryIds: null,
      secretIds: null,
    })).resolves.toContain("No workspace member can be recorded");
    expect(dependencies.saveTagMode).not.toHaveBeenCalled();
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
      actorUserId: "user-1",
      automationsEnabled: true,
      integrationsUrl: "https://app.example.com/settings",
      organizationId: "organization-1",
      source: "automation_run",
    }, dependencies as unknown as WorkspaceToolDependencies);
    const call = (name: string, args: unknown) =>
      callWorkspaceTool(specs.find((spec) => spec.name === name)!, args);
    return { call, dependencies, specs };
  }

  it("describes each tool for the sandbox tool server", () => {
    const definitions = workspaceToolDefinitions(automationRunTools().specs);

    expect(definitions.map((definition) => definition.name)).toEqual([
      "get_workspace",
      "get_automation",
      "get_automation_configuration_schema",
      "create_automation",
      "update_automation",
      "update_tag_mode",
    ]);
    expect(definitions.find((definition) => definition.name === "update_tag_mode")).toMatchObject({
      annotations: { readOnlyHint: false },
      inputSchema: {
        properties: { enabled: { anyOf: [{ type: "boolean" }, { type: "null" }] } },
        type: "object",
      },
    });
    expect(definitions[0]).toMatchObject({ annotations: { readOnlyHint: true } });
    expect(definitions[0]!.inputSchema).not.toHaveProperty("$schema");
  });

  it("reads a left-out nullable field as unchanged", async () => {
    const { call, dependencies } = automationRunTools();

    await expect(call("update_tag_mode", { enabled: false })).resolves.toMatchObject({
      content: [{ text: expect.stringContaining("\"changed\":[\"enabled\"]") }],
    });
    expect(dependencies.saveTagMode).toHaveBeenCalledWith({
      configuration: { ...tagMode, enabled: false },
      organizationId: "organization-1",
      userId: "user-1",
    });
  });

  it("records automations it creates as created by an automation run", async () => {
    const { call, dependencies } = automationRunTools();

    await call("create_automation", {
      configuration: JSON.stringify({
        prompt: "Summarize yesterday's errors.",
        repositoryIds: [ids.repository],
        triggers: automationConfiguration.triggers,
      }),
      enabled: true,
      name: "Daily errors",
    });
    expect(dependencies.captureEvent).toHaveBeenCalledWith(expect.objectContaining({
      properties: expect.objectContaining({ source: "automation_run" }),
    }));
  });

  it("returns invalid arguments and failures as tool errors", async () => {
    const { call } = automationRunTools();

    await expect(call("get_automation", { automationId: "not-a-uuid" })).resolves.toMatchObject({
      content: [{ text: expect.stringContaining("Invalid tool arguments: automationId") }],
      isError: true,
    });
    await expect(call("update_automation", { automationId: ids.automation })).resolves.toEqual({
      content: [{ text: "Nothing to change", type: "text" }],
      isError: true,
    });
  });
});
