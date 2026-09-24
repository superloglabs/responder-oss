import { describe, expect, it } from "vitest";
import { automationConfigurationSchema } from "./config.js";

const baseConfiguration = {
  contextAccountIds: [],
  harness: "codex",
  maxModelRequests: 8,
  maxOutputTokensPerRequest: 4_096,
  maxRuntimeSeconds: 900,
  model: "gpt-5.1-codex",
  modelCredentialId: "21212121-2121-4121-8121-212121212121",
  modelProvider: "openai",
  prompt: "Investigate the alert and make the smallest safe fix.",
  repositoryIds: ["31313131-3131-4131-8131-313131313131"],
  toolPolicy: "full",
  trigger: {
    channelIds: ["C123"],
    eventMode: "both",
    integrationAccountId: "41414141-4141-4141-8141-414141414141",
    kind: "slack",
  },
  workspaceSecretIds: [],
};

describe("automation configuration", () => {
  it("accepts an unattended full-access Slack automation", () => {
    expect(automationConfigurationSchema.parse(baseConfiguration)).toEqual(
      baseConfiguration,
    );
  });

  it("supports Sentry and Discord trigger contracts", () => {
    expect(
      automationConfigurationSchema.parse({
        ...baseConfiguration,
        trigger: {
          eventTypes: ["new_issue", "regression"],
          integrationAccountId: "41414141-4141-4141-8141-414141414141",
          kind: "sentry",
          projectIds: ["project-1"],
        },
      }).trigger.kind,
    ).toBe("sentry");
    expect(
      automationConfigurationSchema.parse({
        ...baseConfiguration,
        trigger: {
          channelIds: ["discord-channel-1"],
          integrationAccountId: "41414141-4141-4141-8141-414141414141",
          kind: "discord",
        },
      }).trigger.kind,
    ).toBe("discord");
  });

  it("restricts the Anthropic-only harness to Anthropic models", () => {
    expect(() =>
      automationConfigurationSchema.parse({
        ...baseConfiguration,
        harness: "claude_agent_sdk",
      })
    ).toThrow("requires an Anthropic model");
  });

  it("uses Responder-funded inference when no model credential is selected", () => {
    const withoutCredential: Record<string, unknown> = { ...baseConfiguration };
    delete withoutCredential.modelCredentialId;
    expect(
      automationConfigurationSchema.parse(withoutCredential).modelCredentialId,
    ).toBeNull();
    expect(
      automationConfigurationSchema.parse({
        ...baseConfiguration,
        modelCredentialId: null,
      }).modelCredentialId,
    ).toBeNull();
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
