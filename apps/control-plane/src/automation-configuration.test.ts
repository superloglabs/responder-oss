import { describe, expect, it } from "vitest";
import type { AutomationConfiguration, AutomationOptions } from "./automations-api";
import { availableAutomationConfiguration } from "./automation-configuration";

const options = {
  accounts: [
    { id: "sentry", provider: "sentry", displayName: "Acme" },
    { id: "datadog", provider: "datadog", displayName: "Datadog" },
  ],
  credentials: [],
  repositories: [{ id: "repository", integrationAccountId: "github", fullName: "acme/app", defaultBranch: "main", private: true }],
  resources: [{ id: "project", integrationAccountId: "sentry", kind: "sentry_project", externalId: "web", displayName: "web" }],
  secrets: [{ id: "secret", name: "TOKEN", allowedHosts: [] }],
} as unknown as AutomationOptions;

const configuration = {
  contextAccountIds: ["datadog", "removed-account"],
  harness: "codex",
  maxModelRequests: 24,
  maxOutputTokensPerRequest: 16_000,
  maxRuntimeSeconds: 1_800,
  model: "gpt-5.4",
  modelCredentialId: null,
  modelProvider: "openai",
  prompt: "Investigate",
  repositoryIds: ["repository", "removed-repository"],
  toolPolicy: "full",
  trigger: { eventTypes: ["new_issue"], integrationAccountId: "sentry", kind: "sentry", projectIds: ["web", "removed-project"] },
  workspaceSecretIds: ["secret", "removed-secret"],
} satisfies AutomationConfiguration;

describe("availableAutomationConfiguration", () => {
  it("drops references that the current options no longer offer", () => {
    expect(availableAutomationConfiguration(configuration, options)).toMatchObject({
      contextAccountIds: ["datadog"],
      repositoryIds: ["repository"],
      trigger: { integrationAccountId: "sentry", projectIds: ["web"] },
      workspaceSecretIds: ["secret"],
    });
  });

  it("clears a trigger whose connection is gone", () => {
    const removed = { ...configuration, trigger: { ...configuration.trigger, integrationAccountId: "removed-account" } };
    expect(availableAutomationConfiguration(removed, options).trigger).toMatchObject({ integrationAccountId: "", projectIds: [] });
  });

  it("clears a trigger connection from another provider", () => {
    const slack = { ...configuration, trigger: { channelIds: ["C1"], eventMode: "mentions", integrationAccountId: "sentry", kind: "slack" } } satisfies AutomationConfiguration;
    expect(availableAutomationConfiguration(slack, options).trigger).toMatchObject({ integrationAccountId: "", channelIds: [] });
  });
});
