import { describe, expect, it } from "vitest";
import type { AutomationConfiguration, AutomationOptions } from "./automations-api";
import { availableAutomationConfiguration, isTriggerComplete, moveItem } from "./automation-configuration";

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
  triggers: [{ eventTypes: ["new_issue"], integrationAccountId: "sentry", kind: "sentry", projectIds: ["web", "removed-project"] }],
  workspaceSecretIds: ["secret", "removed-secret"],
} satisfies AutomationConfiguration;

describe("availableAutomationConfiguration", () => {
  it("drops references that the current options no longer offer", () => {
    expect(availableAutomationConfiguration(configuration, options)).toMatchObject({
      contextAccountIds: ["datadog"],
      repositoryIds: ["repository"],
      triggers: [{ integrationAccountId: "sentry", projectIds: ["web"] }],
      workspaceSecretIds: ["secret"],
    });
  });

  it("clears a trigger whose connection is gone", () => {
    const removed = { ...configuration, triggers: [{ ...configuration.triggers[0], integrationAccountId: "removed-account" }] };
    expect(availableAutomationConfiguration(removed, options).triggers[0]).toMatchObject({ integrationAccountId: "", projectIds: [] });
  });

  it("clears a trigger connection from another provider and keeps the other triggers", () => {
    const schedule = { frequency: "daily", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 } as const;
    const mixed = { ...configuration, triggers: [{ channelIds: ["C1"], eventMode: "mentions", integrationAccountId: "sentry", kind: "slack" }, schedule] } satisfies AutomationConfiguration;
    expect(availableAutomationConfiguration(mixed, options).triggers).toEqual([
      { channelIds: [], eventMode: "mentions", integrationAccountId: "", kind: "slack" },
      schedule,
    ]);
  });
});

describe("isTriggerComplete", () => {
  it("requires a connection and a channel or project for connected triggers", () => {
    expect(isTriggerComplete({ frequency: "hourly", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 })).toBe(true);
    expect(isTriggerComplete({ channelIds: ["C1"], eventMode: "mentions", integrationAccountId: "slack", kind: "slack" })).toBe(true);
    expect(isTriggerComplete({ channelIds: [], eventMode: "mentions", integrationAccountId: "slack", kind: "slack" })).toBe(false);
    expect(isTriggerComplete({ eventTypes: ["new_issue"], integrationAccountId: "", kind: "sentry", projectIds: ["web"] })).toBe(false);
  });
});

describe("moveItem", () => {
  it("moves an item to a position and keeps the others in order", () => {
    expect(moveItem(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b"], "a", 9)).toEqual(["b", "a"]);
    expect(moveItem(["a", "b"], "z", 0)).toEqual(["a", "b"]);
  });
});
