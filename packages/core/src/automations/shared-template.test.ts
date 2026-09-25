import { describe, expect, it } from "vitest";
import {
  shareableAutomationConnectors,
  shareableAutomationTriggers,
  sharedAutomationTemplateSlugSchema,
} from "./shared-template.js";

const accountId = "15151515-1515-4515-8515-151515151515";

describe("shared automation templates", () => {
  it("removes connections, channels, and projects from triggers", () => {
    expect(shareableAutomationTriggers([
      { channelIds: ["C123"], eventMode: "mentions", integrationAccountId: accountId, kind: "slack" },
      { eventTypes: ["regression"], integrationAccountId: accountId, kind: "sentry", projectIds: ["backend"] },
      { channelIds: ["998877"], integrationAccountId: accountId, kind: "discord" },
    ])).toEqual([
      { channelIds: [], eventMode: "mentions", integrationAccountId: "", kind: "slack" },
      { eventTypes: ["regression"], integrationAccountId: "", kind: "sentry", projectIds: [] },
      { channelIds: [], integrationAccountId: "", kind: "discord" },
    ]);
  });

  it("keeps schedule timing without the owner's time zone", () => {
    expect(shareableAutomationTriggers([
      { frequency: "weekly", hour: 9, kind: "schedule", timezone: "Europe/Paris", weekday: 1 },
    ])).toEqual([
      { frequency: "weekly", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 },
    ]);
  });

  it("lists GitHub first, then other providers once, without trigger providers", () => {
    expect(shareableAutomationConnectors({
      contextProviders: ["slack", "datadog", "sentry", "datadog", "posthog"],
      hasRepositories: true,
      triggers: [{ eventTypes: ["new_issue"], integrationAccountId: "", kind: "sentry", projectIds: [] }],
    })).toEqual(["github", "datadog", "slack"]);
    expect(shareableAutomationConnectors({ contextProviders: [], hasRepositories: false, triggers: [] })).toEqual([]);
  });

  it("accepts only generated slugs", () => {
    expect(sharedAutomationTemplateSlugSchema.safeParse("aB3_-xYz09aB3_-x").success).toBe(true);
    expect(sharedAutomationTemplateSlugSchema.safeParse("short").success).toBe(false);
    expect(sharedAutomationTemplateSlugSchema.safeParse("../../etc/passwd").success).toBe(false);
  });
});
