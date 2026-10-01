import { describe, expect, it } from "vitest";
import { automationConfigurationSchema } from "./config.js";

const baseConfiguration = {
  contextAccountIds: [],
  harness: "codex",
  maxModelRequests: 8,
  maxOutputTokensPerRequest: 4_096,
  maxRuntimeSeconds: 900,
  model: "gpt-5.1-codex",
  modelProvider: "openai",
  prompt: "Investigate the alert and make the smallest safe fix.",
  repositoryIds: ["31313131-3131-4131-8131-313131313131"],
  toolPolicy: "full",
  triggers: [{
    channelIds: ["C123"],
    eventMode: "both",
    integrationAccountId: "41414141-4141-4141-8141-414141414141",
    kind: "slack",
  }],
  workspaceSecretIds: [],
};

describe("automation configuration", () => {
  it("accepts an unattended full-access Slack automation", () => {
    expect(automationConfigurationSchema.parse(baseConfiguration)).toEqual(
      { ...baseConfiguration, notifications: [] },
    );
  });

  it("allows up to 1,000 model requests per run", () => {
    expect(automationConfigurationSchema.safeParse({ ...baseConfiguration, maxModelRequests: 1_000 }).success).toBe(true);
    expect(automationConfigurationSchema.safeParse({ ...baseConfiguration, maxModelRequests: 1_001 }).success).toBe(false);
  });

  it("posts notifications only for scheduled and Sentry automations", () => {
    const notification = {
      channelId: "C999",
      integrationAccountId: "41414141-4141-4141-8141-414141414141",
      kind: "slack",
    };
    const schedule = { frequency: "weekly", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 };

    expect(automationConfigurationSchema.parse(baseConfiguration).notifications).toEqual([]);
    expect(automationConfigurationSchema.safeParse({ ...baseConfiguration, notifications: [notification] }).success).toBe(false);
    expect(automationConfigurationSchema.parse({
      ...baseConfiguration,
      notifications: [notification],
      triggers: [schedule],
    }).notifications).toEqual([notification]);
    expect(automationConfigurationSchema.parse({
      ...baseConfiguration,
      notifications: [notification],
      triggers: [{
        eventTypes: ["new_issue"],
        integrationAccountId: "41414141-4141-4141-8141-414141414141",
        kind: "sentry",
        projectIds: ["project-1"],
      }],
    }).notifications).toEqual([notification]);
    expect(automationConfigurationSchema.safeParse({
      ...baseConfiguration,
      notifications: [notification, notification],
      triggers: [schedule],
    }).success).toBe(false);
  });

  it("supports Sentry and Discord trigger contracts", () => {
    expect(
      automationConfigurationSchema.parse({
        ...baseConfiguration,
        triggers: [{
          eventTypes: ["new_issue", "regression"],
          integrationAccountId: "41414141-4141-4141-8141-414141414141",
          kind: "sentry",
          projectIds: ["project-1"],
        }],
      }).triggers[0]?.kind,
    ).toBe("sentry");
    expect(
      automationConfigurationSchema.parse({
        ...baseConfiguration,
        triggers: [{
          channelIds: ["discord-channel-1"],
          integrationAccountId: "41414141-4141-4141-8141-414141414141",
          kind: "discord",
        }],
      }).triggers[0]?.kind,
    ).toBe("discord");
  });

  it("accepts several triggers and requires at least one", () => {
    const schedule = { frequency: "daily", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 };
    expect(
      automationConfigurationSchema.parse({
        ...baseConfiguration,
        triggers: [...baseConfiguration.triggers, schedule],
      }).triggers.map((trigger) => trigger.kind),
    ).toEqual(["slack", "schedule"]);
    expect(() =>
      automationConfigurationSchema.parse({ ...baseConfiguration, triggers: [] })
    ).toThrow();
  });

  it("restricts the Anthropic-only harness to Anthropic models", () => {
    expect(() =>
      automationConfigurationSchema.parse({
        ...baseConfiguration,
        harness: "claude_agent_sdk",
      })
    ).toThrow("requires an Anthropic model");
  });

  it("does not keep a model credential on the automation", () => {
    expect(
      automationConfigurationSchema.parse({
        ...baseConfiguration,
        modelCredentialId: "21212121-2121-4121-8121-212121212121",
      }),
    ).not.toHaveProperty("modelCredentialId");
  });

  it("requires at least one repository and bounded unattended limits", () => {
    expect(() =>
      automationConfigurationSchema.parse({
        ...baseConfiguration,
        maxRuntimeSeconds: 7_200,
        repositoryIds: [],
      })
    ).toThrow();
  });

  it("rejects duplicate linked resources before persistence", () => {
    const repositoryId = baseConfiguration.repositoryIds[0];
    expect(() => automationConfigurationSchema.parse({
      ...baseConfiguration,
      repositoryIds: [repositoryId, repositoryId],
    })).toThrow("Repository IDs must be unique");
    expect(() => automationConfigurationSchema.parse({
      ...baseConfiguration,
      workspaceSecretIds: [
        "51515151-5151-4151-8151-515151515151",
        "51515151-5151-4151-8151-515151515151",
      ],
    })).toThrow("Workspace secret IDs must be unique");
    const contextAccountId = "41414141-4141-4141-8141-414141414141";
    expect(() => automationConfigurationSchema.parse({
      ...baseConfiguration,
      contextAccountIds: [contextAccountId, contextAccountId],
    })).toThrow("Context account IDs must be unique");
  });
});
