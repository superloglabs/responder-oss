import { describe, expect, it } from "vitest";
import {
  agentConfigurationSchema,
  slackThreadModeConfigurationSchema,
} from "./config.js";

const baseConfiguration = {
  name: "Checkout guardian",
  description: "Investigates checkout failures.",
  model: "instance/default",
  instructions: "Find the smallest safe remediation.",
  prMode: false,
  repositoryIds: [],
  trigger: {
    kind: "slack_mention" as const,
    integrationAccountId: "02020202-0202-4202-8202-020202020202",
    channelIds: [],
  },
  reporting: {
    mode: "thread" as const,
  },
};

describe("agent configuration", () => {
  it("keeps tag mode configuration to prompt and context capabilities", () => {
    const parsed = slackThreadModeConfigurationSchema.parse({
      enabled: true,
      model: "instance/default",
      instructions: "Investigate the request.",
      repositoryIds: ["14141414-1414-4414-8414-141414141414"],
    });

    expect(parsed).toEqual({
      enabled: true,
      model: "instance/default",
      instructions: "Investigate the request.",
      repositoryIds: ["14141414-1414-4414-8414-141414141414"],
      contextAccountIds: [],
      contextResourceIds: [],
      secretIds: [],
    });
    expect(parsed).not.toHaveProperty("prMode");
    expect(parsed).not.toHaveProperty("createLinearTickets");
  });

  it("accepts a Slack mention agent that reports in the source thread", () => {
    const parsed = agentConfigurationSchema.safeParse(baseConfiguration);

    expect(parsed.success).toBe(true);
    expect(parsed.data?.contextAccountIds).toEqual([]);
    expect(parsed.data?.contextResourceIds).toEqual([]);
    expect(parsed.data?.secretIds).toEqual([]);
    expect(parsed.data?.createLinearTickets).toBe(false);
    expect(parsed.data?.linearIssueTemplate).toContain("{{issue_id}}");
  });

  it("requires a non-empty Linear template when ticket settings are supplied", () => {
    const parsed = agentConfigurationSchema.safeParse({
      ...baseConfiguration,
      createLinearTickets: true,
      linearIssueTemplate: "   ",
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["linearIssueTemplate"]);
  });

  it("requires a repository when remediation is enabled", () => {
    const parsed = agentConfigurationSchema.safeParse({
      ...baseConfiguration,
      prMode: true,
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["repositoryIds"]);
  });

  it("supports on-request pull requests and upgrades the legacy boolean mode", () => {
    const manual = agentConfigurationSchema.safeParse({
      ...baseConfiguration,
      prMode: "manual",
      repositoryIds: ["14141414-1414-4414-8414-141414141414"],
    });
    const legacy = agentConfigurationSchema.parse({
      ...baseConfiguration,
      prMode: true,
      repositoryIds: ["14141414-1414-4414-8414-141414141414"],
    });

    expect(manual.success && manual.data.prMode).toBe("manual");
    expect(legacy.prMode).toBe("always");
  });

  it("requires an output channel for non-Slack triggers", () => {
    const parsed = agentConfigurationSchema.safeParse({
      ...baseConfiguration,
      trigger: {
        kind: "sentry_issue",
        integrationAccountId: "02020202-0202-4202-8202-020202020202",
        projectIds: ["checkout"],
      },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["reporting", "mode"]);
  });

  it("stores an optional output severity filter", () => {
    const parsed = agentConfigurationSchema.safeParse({
      ...baseConfiguration,
      reporting: {
        mode: "output_channel",
        integrationAccountId: "02020202-0202-4202-8202-020202020202",
        outputChannelId: "incident-reports",
        severities: ["SEV-1", "SEV-2"],
      },
    });

    expect(parsed.success).toBe(true);
    expect(
      parsed.success && parsed.data.reporting.mode !== "thread"
        ? parsed.data.reporting.severities
        : undefined,
    ).toEqual(["SEV-1", "SEV-2"]);
  });

  it("rejects an empty selected severity filter", () => {
    const parsed = agentConfigurationSchema.safeParse({
      ...baseConfiguration,
      reporting: {
        mode: "output_channel",
        integrationAccountId: "02020202-0202-4202-8202-020202020202",
        outputChannelId: "incident-reports",
        severities: [],
      },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["reporting", "severities"]);
  });
});
