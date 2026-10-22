import { describe, expect, it } from "vitest";
import { automationUsesIssueCatalog } from "./issue-catalog.js";

const slack = { channelId: "C0123", integrationAccountId: "61616161-6161-4161-8161-616161616161", kind: "slack" };

describe("automationUsesIssueCatalog", () => {
  it("is on for alert automations that report to Slack", () => {
    expect(automationUsesIssueCatalog({ notifications: [slack], triggers: [{ kind: "sentry" }] })).toBe(true);
    expect(automationUsesIssueCatalog({ notifications: [slack], triggers: [{ kind: "schedule" }, { kind: "honeycomb" }] })).toBe(true);
  });

  it("is off without Slack notifications or an alert trigger", () => {
    expect(automationUsesIssueCatalog({ notifications: [], triggers: [{ kind: "sentry" }] })).toBe(false);
    expect(automationUsesIssueCatalog({ notifications: [slack], triggers: [{ kind: "schedule" }, { kind: "github" }] })).toBe(false);
  });
});
