import { describe, expect, it } from "vitest";
import { automationTriggerIsAlert } from "./alert-trigger.js";

describe("automationTriggerIsAlert", () => {
  it("counts alert sources and webhooks as alerts", () => {
    for (const provider of ["axiom", "betterstack", "errors", "honeycomb", "sentry", "signoz", "webhook"]) {
      expect(automationTriggerIsAlert({ provider })).toBe(true);
    }
  });

  it("counts a Slack message from an app, such as an alert bot, as an alert", () => {
    expect(automationTriggerIsAlert({
      attributes: { authorId: "B1", authorType: "app", channelId: "C1" },
      provider: "slack",
    })).toBe(true);
    expect(automationTriggerIsAlert({ attributes: { channelId: "C1" }, provider: "slack" })).toBe(true);
  });

  it("does not count a Slack message from a person as an alert", () => {
    expect(automationTriggerIsAlert({
      attributes: { authorId: "U1", authorType: "person", channelId: "C1" },
      provider: "slack",
    })).toBe(false);
  });

  it("does not count schedules or other sources as alerts", () => {
    for (const trigger of [{ provider: "schedule" }, { provider: "github" }, {}]) {
      expect(automationTriggerIsAlert(trigger)).toBe(false);
    }
  });
});
