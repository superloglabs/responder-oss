import { describe, expect, it } from "vitest";
import { connectorNames, connectorSummary, triggerEventLabel, triggerProviderLabel } from "./automation-list-presentation";

describe("automation list presentation", () => {
  it("summarizes connectors by the first provider and a count", () => {
    expect(connectorSummary([])).toBe("None");
    expect(connectorSummary(["github"])).toBe("GitHub");
    expect(connectorSummary(["github", "sentry", "datadog"])).toBe("GitHub +2");
    expect(connectorNames(["github", "slack"])).toBe("GitHub, Slack");
  });

  it("labels the trigger provider with the shared provider name", () => {
    expect(triggerProviderLabel({ channelIds: [], eventMode: "mentions", integrationAccountId: "a", kind: "slack" })).toBe("Slack");
    expect(triggerProviderLabel({ eventTypes: ["new_issue"], integrationAccountId: "a", kind: "sentry", projectIds: [] })).toBe("Sentry");
    expect(triggerProviderLabel({ channelIds: [], integrationAccountId: "a", kind: "discord" })).toBe("Discord");
    expect(triggerProviderLabel({ frequency: "hourly", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 })).toBe("Schedule");
  });

  it("labels the trigger event", () => {
    expect(triggerEventLabel({ channelIds: [], eventMode: "mentions", integrationAccountId: "a", kind: "slack" })).toBe("App mentioned");
    expect(triggerEventLabel({ channelIds: [], eventMode: "every_message", integrationAccountId: "a", kind: "slack" })).toBe("New message");
    expect(triggerEventLabel({ eventTypes: ["regression"], integrationAccountId: "a", kind: "sentry", projectIds: [] })).toBe("Issue regression");
    expect(triggerEventLabel({ eventTypes: ["new_issue", "regression"], integrationAccountId: "a", kind: "sentry", projectIds: [] })).toBe("New issue or regression");
    expect(triggerEventLabel({ channelIds: [], integrationAccountId: "a", kind: "discord" })).toBe("Command in channel");
    expect(triggerEventLabel({ frequency: "weekly", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 })).toBe("Mondays at 09:00");
  });
});
