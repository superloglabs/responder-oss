import { describe, expect, it } from "vitest";
import type { AutomationConfiguration, AutomationOptions } from "./automations-api";
import { availableAutomationConfiguration, defaultContextAccountIds, excludedSentryEnvironments, isTriggerComplete, moveItem, scheduleCron, scheduleCronError, sentryEnvironmentChoices, slackFiltersInUse, slackPhrasesError, slackPhrasesFromText, withScheduleFrequency } from "./automation-configuration";

const options = {
  accounts: [
    { id: "sentry", provider: "sentry", displayName: "Acme" },
    { id: "datadog", provider: "datadog", displayName: "Datadog" },
  ],
  credentials: [],
  repositories: [{ id: "repository", integrationAccountId: "github", fullName: "acme/app", defaultBranch: "main", private: true }],
  resources: [{ id: "project", integrationAccountId: "sentry", kind: "sentry_project", externalId: "web", displayName: "web" }],
  secrets: [{ id: "secret", name: "TOKEN", allowedHosts: [] }],
  skills: [{ id: "skill", name: "billing-api", description: "Billing", secretNames: [] }],
} as unknown as AutomationOptions;

const configuration = {
  contextAccountIds: ["datadog", "removed-account"],
  harness: "codex",
  maxModelRequests: 24,
  maxOutputTokensPerRequest: 16_000,
  maxRuntimeSeconds: 1_800,
  model: "gpt-5.4",
  modelProvider: "openai",
  notifications: [],
  prompt: "Investigate",
  repositoryIds: ["repository", "removed-repository"],
  skillIds: ["skill", "removed-skill"],
  toolPolicy: "full",
  triggers: [{ eventTypes: ["new_issue"], integrationAccountId: "sentry", kind: "sentry", projectIds: ["web", "removed-project"] }],
  workspaceSecretIds: ["secret", "removed-secret"],
} satisfies AutomationConfiguration;

describe("availableAutomationConfiguration", () => {
  it("drops references that the current options no longer offer", () => {
    expect(availableAutomationConfiguration(configuration, options)).toMatchObject({
      contextAccountIds: ["datadog"],
      repositoryIds: ["repository"],
      skillIds: ["skill"],
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

  it("keeps only the GitHub trigger repositories its connection still offers", () => {
    const withGitHub = {
      ...options,
      accounts: [...options.accounts, { id: "github", provider: "github", displayName: "acme" }, { id: "other-github", provider: "github", displayName: "other" }],
      repositories: [...options.repositories, { id: "other-repository", integrationAccountId: "other-github", fullName: "other/app", defaultBranch: "main", private: true }],
    } as AutomationOptions;
    const github: AutomationConfiguration["triggers"][number] = { eventTypes: ["merged"], integrationAccountId: "github", kind: "github", repositoryIds: ["repository", "other-repository", "removed-repository"] };
    expect(availableAutomationConfiguration({ ...configuration, triggers: [github] }, withGitHub).triggers).toEqual([
      { ...github, repositoryIds: ["repository"] },
    ]);
    expect(availableAutomationConfiguration({ ...configuration, triggers: [github] }, options).triggers).toEqual([
      { ...github, integrationAccountId: "", repositoryIds: [] },
    ]);
  });
});

describe("defaultContextAccountIds", () => {
  it("selects every supported connected connector except GitHub", () => {
    expect(defaultContextAccountIds({
      ...options,
      accounts: [
        { id: "sentry", provider: "sentry", displayName: "Acme" },
        { id: "github", provider: "github", displayName: "acme" },
        { id: "aws-production", provider: "aws", displayName: "Production" },
        { id: "aws-staging", provider: "aws", displayName: "Staging" },
        { id: "discord", provider: "discord", displayName: "Server" },
      ],
    } as AutomationOptions)).toEqual(["sentry", "aws-production", "aws-staging"]);
  });

  it("stops at the 50 connectors the server accepts", () => {
    const accounts = Array.from({ length: 51 }, (_, index) => ({ id: `mcp-${index}`, provider: "custom_mcp", displayName: `MCP ${index}` }));
    expect(defaultContextAccountIds({ ...options, accounts } as AutomationOptions)).toHaveLength(50);
  });

  it("keeps already selected connectors first within the limit", () => {
    const accounts = Array.from({ length: 51 }, (_, index) => ({ id: `mcp-${index}`, provider: "custom_mcp", displayName: `MCP ${index}` }));
    const selected = defaultContextAccountIds({ ...options, accounts } as AutomationOptions, ["mcp-50"]);
    expect(selected).toHaveLength(50);
    expect(selected.slice(0, 2)).toEqual(["mcp-50", "mcp-0"]);
  });
});

describe("isTriggerComplete", () => {
  it("requires a connection and a channel or project for connected triggers", () => {
    expect(isTriggerComplete({ frequency: "hourly", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 })).toBe(true);
    expect(isTriggerComplete({ cron: "0 9 * * 1-5", frequency: "custom", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 })).toBe(true);
    expect(isTriggerComplete({ cron: "0 9 * *", frequency: "custom", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 })).toBe(false);
    expect(isTriggerComplete({ channelIds: ["C1"], eventMode: "mentions", integrationAccountId: "slack", kind: "slack" })).toBe(true);
    expect(isTriggerComplete({ channelIds: [], eventMode: "mentions", integrationAccountId: "slack", kind: "slack" })).toBe(false);
    expect(isTriggerComplete({ eventTypes: ["new_issue"], integrationAccountId: "", kind: "sentry", projectIds: ["web"] })).toBe(false);
    expect(isTriggerComplete({ integrationAccountId: "axiom", kind: "axiom" })).toBe(true);
    expect(isTriggerComplete({ integrationAccountId: "", kind: "axiom" })).toBe(false);
    expect(isTriggerComplete({ integrationAccountId: "devrev", kind: "devrev" })).toBe(true);
    expect(isTriggerComplete({ integrationAccountId: "", kind: "devrev" })).toBe(false);
    expect(isTriggerComplete({ eventTypes: ["opened"], integrationAccountId: "github", kind: "github", repositoryIds: ["repository-1"] })).toBe(true);
    expect(isTriggerComplete({ eventTypes: ["opened"], integrationAccountId: "github", kind: "github", repositoryIds: [] })).toBe(false);
    expect(isTriggerComplete({ eventTypes: ["opened"], integrationAccountId: "", kind: "github", repositoryIds: ["repository-1"] })).toBe(false);
  });
});

describe("Sentry environment choices", () => {
  it("keeps excluded environments that Sentry no longer lists", () => {
    expect(sentryEnvironmentChoices(["dev", "production"], ["old-staging", "dev"])).toEqual(["dev", "production", "old-staging"]);
  });

  it("stores the unchecked environments", () => {
    const choices = ["dev", "production", "staging"];
    expect(excludedSentryEnvironments(choices, ["production"])).toEqual(["dev", "staging"]);
    expect(excludedSentryEnvironments(choices, choices)).toBeUndefined();
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

describe("scheduleCron", () => {
  it("writes the current timing as a cron expression", () => {
    expect(scheduleCron({ frequency: "hourly", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 })).toBe("0 * * * *");
    expect(scheduleCron({ frequency: "daily", hour: 7, kind: "schedule", timezone: "UTC", weekday: 1 })).toBe("0 7 * * *");
    expect(scheduleCron({ frequency: "weekly", hour: 18, kind: "schedule", timezone: "UTC", weekday: 5 })).toBe("0 18 * * 5");
    expect(scheduleCron({ cron: "*/30 * * * *", frequency: "custom", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 })).toBe("*/30 * * * *");
  });
});

describe("withScheduleFrequency", () => {
  it("converts the current preset timing each time a schedule becomes custom", () => {
    const custom = { cron: "0 */6 * * *", frequency: "custom", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 } as const;
    const daily = withScheduleFrequency(custom, "daily");
    expect(daily).toEqual({ frequency: "daily", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 });
    expect(withScheduleFrequency({ ...daily, hour: 14 }, "custom")).toMatchObject({ cron: "0 14 * * *", frequency: "custom" });
  });
});

describe("scheduleCronError", () => {
  const custom = (cron: string) => ({ cron, frequency: "custom", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 } as const);

  it("explains why a custom expression cannot be saved", () => {
    const everyMinute = Array.from({ length: 60 }, (_, minute) => minute).join(",");
    expect(scheduleCronError(custom(`${everyMinute} * * * *`))).toBeNull();
    expect(scheduleCronError(custom(`0 9 * * ${"1,".repeat(130)}1`))).toBe("Use 255 characters or fewer.");
    expect(scheduleCronError(custom("0 9 * *"))).toBe("Use five fields: minute, hour, day of month, month, day of week.");
    expect(scheduleCronError(custom("0 24 * * *"))).toBe("Use minute 0-59, hour 0-23, day 1-31, month 1-12, and day of week 0-7.");
    expect(scheduleCronError(custom("0 0 30 2 *"))).toBe("This date never occurs.");
    expect(scheduleCronError({ frequency: "daily", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 })).toBeNull();
  });
});

describe("Slack trigger filters", () => {
  const slack = { channelIds: ["C1"], eventMode: "mentions" as const, integrationAccountId: "account", kind: "slack" as const };

  it("shows only the filters the trigger sets", () => {
    expect(slackFiltersInUse(slack)).toEqual([]);
    expect(slackFiltersInUse({ ...slack, ignoredAuthors: [], ignoredPhrases: ["^Resolved:"], includedAuthors: [{ id: "U1", name: "Ada" }] }))
      .toEqual(["includedAuthors", "ignoredPhrases"]);
  });

  it("reads one phrase per line and reports the first invalid one", () => {
    // Spaces can be part of an expression, so lines are kept as typed.
    expect(slackPhrasesFromText("^Resolved: \n\n^Resolved: \n  \ndeploy\n")).toEqual(["^Resolved: ", "deploy"]);
    expect(slackPhrasesFromText("\n  \n")).toBeUndefined();
    expect(slackPhrasesError(undefined)).toBeNull();
    expect(slackPhrasesError(["ok", "(unclosed"])).toBe('"(unclosed" is not a valid regular expression.');
  });
});
