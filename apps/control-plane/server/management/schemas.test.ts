import { describe, expect, it } from "vitest";
import { defaultAutomationModelSettings } from "../../../../packages/core/src/automations/config.js";
import { automationConfigurationOutputSchema } from "./schemas.js";

describe("management schemas", () => {
  it("returns an automation on the plan's model", () => {
    const configuration = {
      ...defaultAutomationModelSettings,
      contextAccountIds: [],
      harness: "plan",
      model: "default",
      modelProvider: "plan",
      notifications: [],
      prompt: "Summarize yesterday's errors.",
      repositoryIds: [],
      skillIds: [],
      toolPolicy: "full",
      triggers: [{ kind: "webhook" }],
      workspaceSecretIds: [],
    };

    expect(automationConfigurationOutputSchema.parse(configuration)).toMatchObject({
      harness: "plan",
      model: "default",
      modelProvider: "plan",
    });
  });
});
