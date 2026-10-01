import { describe, expect, it } from "vitest";
import { automationSetupReturnPath, sharedTemplateSetupPath, sharedTriggerDescription } from "./shared-automation-template-presentation";

describe("shared automation template presentation", () => {
  it("describes each trigger without the owner's resources", () => {
    expect(sharedTriggerDescription({ channelIds: [], eventMode: "mentions", integrationAccountId: "", kind: "slack" }))
      .toBe("When someone mentions the app in a Slack channel you choose");
    expect(sharedTriggerDescription({ eventTypes: ["new_issue", "regression"], integrationAccountId: "", kind: "sentry", projectIds: [] }))
      .toBe("When Sentry reports a new issue or a regression in a project you choose");
    expect(sharedTriggerDescription({ eventTypes: ["regression"], integrationAccountId: "", kind: "sentry", projectIds: [] }))
      .toBe("When Sentry reports a regression in a project you choose");
    expect(sharedTriggerDescription({ channelIds: [], integrationAccountId: "", kind: "discord" }))
      .toBe("When someone runs /automate in a Discord channel you choose");
    expect(sharedTriggerDescription({ frequency: "hourly", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 }))
      .toBe("Every hour, in your time zone");
  });

  it("opens the create page with the template", () => {
    expect(sharedTemplateSetupPath("aB3_-xYz09aB3_-x")).toBe("/automations/new?shared=aB3_-xYz09aB3_-x");
  });

  it("returns to the template setup only from its create page", () => {
    expect(automationSetupReturnPath({ pathname: "/automations/new", search: "?shared=aB3_-xYz09aB3_-x&signed_up=1" })).toBe("/automations/new?shared=aB3_-xYz09aB3_-x");
    expect(automationSetupReturnPath({ pathname: "/automations/new", search: "?template=triage-sentry-issues&signup=1&signed_up=1" })).toBe("/automations/new?template=triage-sentry-issues");
    expect(automationSetupReturnPath({ pathname: "/automations/new", search: "?signup=1" })).toBeNull();
    expect(automationSetupReturnPath({ pathname: "/agents", search: "?shared=aB3_-xYz09aB3_-x" })).toBeNull();
  });
});
