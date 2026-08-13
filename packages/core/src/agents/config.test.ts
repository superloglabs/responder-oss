import { describe, expect, it } from "vitest";
import { agentConfigurationSchema } from "./config.js";

const baseConfiguration = {
  name: "Checkout guardian",
  description: "Investigates checkout failures.",
  model: "instance/default",
  instructions: "Find the smallest safe remediation.",
  prMode: false,
  repositoryIds: [],
  trigger: {
    kind: "slack_mention" as const,
    integrationAccountId: "2bcf1cc5-8589-4465-a9f2-7a461d35a43e",
    channelIds: [],
  },
  reporting: {
    mode: "thread" as const,
  },
};

describe("agent configuration", () => {
  it("accepts a Slack mention agent that reports in the source thread", () => {
    const parsed = agentConfigurationSchema.safeParse(baseConfiguration);

    expect(parsed.success).toBe(true);
    expect(parsed.data?.contextAccountIds).toEqual([]);
    expect(parsed.data?.contextResourceIds).toEqual([]);
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
      repositoryIds: ["98bf28fc-92a9-41b2-8108-70db67029f48"],
    });
    const legacy = agentConfigurationSchema.parse({
      ...baseConfiguration,
      prMode: true,
      repositoryIds: ["98bf28fc-92a9-41b2-8108-70db67029f48"],
    });

    expect(manual.success && manual.data.prMode).toBe("manual");
    expect(legacy.prMode).toBe("always");
  });

  it("requires an output channel for non-Slack triggers", () => {
    const parsed = agentConfigurationSchema.safeParse({
      ...baseConfiguration,
      trigger: {
        kind: "sentry_issue",
        integrationAccountId: "2bcf1cc5-8589-4465-a9f2-7a461d35a43e",
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
        integrationAccountId: "2bcf1cc5-8589-4465-a9f2-7a461d35a43e",
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
        integrationAccountId: "2bcf1cc5-8589-4465-a9f2-7a461d35a43e",
        outputChannelId: "incident-reports",
        severities: [],
      },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["reporting", "severities"]);
  });
});
