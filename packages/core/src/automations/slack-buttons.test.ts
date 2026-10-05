import { describe, expect, it } from "vitest";
import {
  automationButtonIndex,
  automationButtonsSchema,
  pressedAutomationButtonBlocks,
} from "./slack-buttons.js";

describe("automation Slack buttons", () => {
  it("reads a button's position from its action ID", () => {
    expect(automationButtonIndex("automation_run_button:0")).toBe(0);
    expect(automationButtonIndex("automation_run_button:4")).toBe(4);
    expect(automationButtonIndex("automation_run_button:5")).toBeNull();
    expect(automationButtonIndex("automation_run_button:x")).toBeNull();
    expect(automationButtonIndex("create_issue_pull_request")).toBeNull();
  });

  it("accepts up to five buttons with their own labels", () => {
    expect(automationButtonsSchema.safeParse([{ label: " Create PR ", style: "primary" }]).data)
      .toEqual([{ label: "Create PR", style: "primary" }]);
    expect(automationButtonsSchema.safeParse([{ label: "A" }, { label: "A" }]).success).toBe(false);
    expect(automationButtonsSchema.safeParse([{ label: "x".repeat(76) }]).success).toBe(false);
    expect(automationButtonsSchema.safeParse([{ label: "A", url: "https://example.com" }]).success).toBe(false);
  });

  it("replaces the buttons with who pressed which one", () => {
    expect(pressedAutomationButtonBlocks(
      [
        { block_id: "text", type: "section" },
        { block_id: "automation_run_buttons", type: "actions" },
      ],
      { label: "Ship <it> & go", userId: "U123" },
    )).toEqual([
      { block_id: "text", type: "section" },
      { elements: [{ text: "<@U123> pressed *Ship &lt;it&gt; &amp; go*", type: "mrkdwn" }], type: "context" },
    ]);
  });
});
